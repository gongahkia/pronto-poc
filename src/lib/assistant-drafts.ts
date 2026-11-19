import { createHash, randomUUID } from "node:crypto";
import { recordAuditLog } from "@/lib/audit";
import { query, transaction, vectorLiteral, type Queryable } from "@/lib/db";
import { chunkText } from "@/lib/knowledge/chunk";
import { getEmbeddingProvider } from "@/lib/llm";
import { assertConfigurationApproved } from "@/lib/managed-approvals";
import {
  compileTriageFlowToEscalationRules,
  validateAndNormalizeTriageFlow,
  type TriageFlowDraft,
} from "@/lib/triage-flow";
import type { AgentConfigUpdate } from "@/lib/agent/config";
import { normalizeVoiceDraft } from "@/lib/voice-draft";
import { DEMO_CLIENT_ID, usesDemoTextKnowledge } from "@/lib/customer-demo-boundary";
import { usesInstagramTestTextKnowledge } from "@/lib/channels/instagram-test-ai";
import { LOCAL_TEXT_RETRIEVAL_PROFILE } from "@/lib/llm/demo-models";

export type KnowledgeDraftChange = {
  sourceId: string;
  authorUserId?: string;
  action: "upsert" | "delete";
  title: string;
  content: string;
  sourceType: string;
  metadata: Record<string, unknown>;
};

export type VoiceDraft = {
  title: string;
  content: string;
  attributes?: Record<string, unknown>;
  sourceNotes?: string | null;
  examples: Array<{
    customerMessage: string;
    idealResponse: string;
    notes: string;
    active: boolean;
  }>;
};

export type AssistantDraft = {
  client_id: string;
  base_fingerprint: string;
  voice: VoiceDraft | null;
  flow: TriageFlowDraft | null;
  config: AgentConfigUpdate | null;
  knowledge_changes: Record<string, KnowledgeDraftChange>;
  updated_at: Date;
  edit_version: number;
};

export class DraftConflictError extends Error {
  constructor() {
    super("The live assistant changed after this draft was started. Discard the draft and review the current version before editing again.");
  }
}

export async function getAssistantDraft(clientId: string): Promise<AssistantDraft | null> {
  const result = await query<AssistantDraft>(
    "select client_id, base_fingerprint, voice, flow, config, knowledge_changes, updated_at, edit_version from assistant_drafts where client_id = $1",
    [clientId],
  );
  return result.rows[0] ?? null;
}

export async function getAssistantRevision(clientId: string): Promise<{ revision: number; publishedAt: Date | null }> {
  const result = await query<{ revision: number; published_at: Date | null }>(
    "select revision, published_at from assistant_publications where client_id = $1",
    [clientId],
  );
  return {
    revision: result.rows[0]?.revision ?? 0,
    publishedAt: result.rows[0]?.published_at ?? null,
  };
}

async function ensureDraft(clientId: string, actorUserId: string, db: Queryable = { query }): Promise<void> {
  const fingerprint = await liveFingerprint(db, clientId);
  await db.query(
    `insert into assistant_drafts (client_id, base_fingerprint, updated_by)
     values ($1, $2, $3)
     on conflict (client_id) do nothing`,
    [clientId, fingerprint, actorUserId],
  );
}

export async function stageVoice(input: {
  clientId: string;
  actorUserId: string;
  voice: VoiceDraft;
  expectedVersion?: number;
}): Promise<number> {
  const voice = normalizeVoiceDraft(input.voice);
  return saveDraftSection({ ...input, section: "voice", value: voice });
}

export async function stageFlow(input: {
  clientId: string;
  actorUserId: string;
  nodes: unknown;
  edges: unknown;
  expectedVersion?: number;
}): Promise<number> {
  const flow = validateAndNormalizeTriageFlow({ nodes: input.nodes, edges: input.edges });
  return saveDraftSection({ ...input, section: "flow", value: flow });
}

export class DraftEditConflictError extends Error {
  constructor() { super("These settings changed in another tab or session. Your edits are still here. Review the latest saved version before saving again."); }
}

async function saveDraftSection(input: { clientId: string; actorUserId: string; section: "voice" | "flow";
  value: VoiceDraft | TriageFlowDraft; expectedVersion?: number }): Promise<number> {
  return transaction(async db => {
    if (input.expectedVersion !== undefined) {
      const current = await db.query<{ edit_version: number }>("select edit_version from assistant_drafts where client_id = $1 for update", [input.clientId]);
      if ((current.rows[0]?.edit_version ?? 0) !== input.expectedVersion) throw new DraftEditConflictError();
    }
    await ensureDraft(input.clientId, input.actorUserId, db);
    // The version predicate also handles concurrent first saves, when no row existed to lock.
    const result = await db.query<{ edit_version: number }>(`update assistant_drafts set ${input.section} = $2::jsonb,
      updated_by = $3, edit_version = edit_version + 1, updated_at = now()
      where client_id = $1 and ($4::integer is null or edit_version = $4) returning edit_version`,
      [input.clientId, JSON.stringify(input.value), input.actorUserId, input.expectedVersion === undefined ? null : input.expectedVersion || 1]);
    if (!result.rows[0]) throw new DraftEditConflictError();
    return result.rows[0].edit_version;
  });
}

export async function stageAgentConfig(input: AgentConfigUpdate): Promise<void> {
  const actor = await query<{ role: string }>("select role from users where id = $1", [input.actorUserId]);
  if (actor.rows[0]?.role !== "operator") throw new Error("Only a Pronto operator may prepare agent tuning.");
  await ensureDraft(input.clientId, input.actorUserId);
  await query(
    `update assistant_drafts set config = $2::jsonb, updated_by = $3, 
       edit_version = edit_version + 1, updated_at = now() where client_id = $1`,
    [input.clientId, JSON.stringify(input), input.actorUserId],
  );
}

export async function stageKnowledge(input: {
  clientId: string;
  actorUserId: string;
  sourceId?: string;
  action: "upsert" | "delete";
  title?: string;
  content?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
  allowNewSourceId?: boolean;
  proposalAuthorUserId?: string;
}): Promise<string> {
  if (input.allowNewSourceId || input.proposalAuthorUserId) {
    const actor = await query<{ role: string }>("select role from users where id = $1", [input.actorUserId]);
    if (actor.rows[0]?.role !== "operator") throw new Error("Only Pronto may prepare an approved suggestion.");
  }
  const localText = await usesDemoTextKnowledge(input.clientId) || await usesInstagramTestTextKnowledge(input.clientId);
  await ensureDraft(input.clientId, input.actorUserId);
  const sourceId = input.sourceId ?? randomUUID();
  const draft = await getAssistantDraft(input.clientId);
  if (!draft) throw new Error("Assistant draft could not be created.");
  const existingChange = draft.knowledge_changes[sourceId];
  const existingSource = input.sourceId
    ? await query<{ title: string; content: string; source_type: string; metadata: Record<string, unknown> }>(
        "select title, content, source_type, metadata from knowledge_sources where id = $1 and client_id = $2",
        [sourceId, input.clientId],
      )
    : null;
  if (input.sourceId && !existingSource?.rows[0] && !existingChange && !input.allowNewSourceId) {
    throw new Error("Knowledge source not found.");
  }
  const source = existingSource?.rows[0];
  const changes = { ...draft.knowledge_changes };
  if (input.action === "delete" && !source) {
    delete changes[sourceId];
  } else {
    changes[sourceId] = {
      sourceId,
      authorUserId: input.proposalAuthorUserId ?? input.actorUserId,
      action: input.action,
      title: input.title?.trim() ?? existingChange?.title ?? source?.title ?? "",
      content: input.content?.trim() ?? existingChange?.content ?? source?.content ?? "",
      sourceType: input.sourceType ?? existingChange?.sourceType ?? source?.source_type ?? "client_manual",
      metadata: {
        ...(input.metadata ?? existingChange?.metadata ?? source?.metadata ?? {}),
        proposalAuthorId: input.proposalAuthorUserId ?? input.actorUserId,
        sourceReference: String(input.metadata?.sourceUrl ?? input.metadata?.sourceReference ??
          input.metadata?.fileName ?? input.metadata?.filename ?? input.metadata?.entryMode ?? existingChange?.metadata?.sourceReference ?? source?.metadata?.sourceUrl ??
          source?.source_type ?? input.sourceType ?? "manual_proposal"),
        ...(localText ? { syntheticDemo: true, approvedByRestaurant: false } : {}),
      },
    };
  }
  const change = changes[sourceId];
  if (change?.action === "upsert" && (!change.title || !change.content)) {
    throw new Error("A source title and content are required.");
  }
  const config = change?.action === "upsert" && !localText
    ? await query<{ embedding_model: string; embedding_provider: string }>(
        "select embedding_model, embedding_provider from agent_configs where client_id = $1",
        [input.clientId],
      )
    : null;
  const embeddingModel = localText ? "none" : process.env.PRONTO_EMBEDDING_MODEL ??
    config?.rows[0]?.embedding_model ?? process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const provider = process.env.PRONTO_EMBEDDING_PROVIDER ?? config?.rows[0]?.embedding_provider;
  const chunks = change?.action === "upsert"
    ? chunkText(change.content, { maxCharacters: 900, overlap: 120 })
    : [];
  const embeddings = chunks.length && !localText
    ? await getEmbeddingProvider(provider).embed(chunks.map((chunk) => chunk.content), embeddingModel)
    : [];

  await transaction(async (db) => {
    const locked = await db.query<{ knowledge_changes: Record<string, KnowledgeDraftChange> }>(
      "select knowledge_changes from assistant_drafts where client_id = $1 for update",
      [input.clientId],
    );
    if (!locked.rows[0]) throw new Error("Assistant draft could not be found.");
    const currentChanges = { ...locked.rows[0].knowledge_changes };
    if (change) currentChanges[sourceId] = change;
    else delete currentChanges[sourceId];
    await db.query("delete from assistant_draft_chunks where client_id = $1 and source_id = $2", [
      input.clientId, sourceId,
    ]);
    for (const [index, chunk] of chunks.entries()) {
      await db.query(
        `insert into assistant_draft_chunks
         (client_id, source_id, chunk_index, content, token_estimate, embedding, embedding_model, embedding_dimensions, metadata)
         values ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9::jsonb)`,
        [input.clientId, sourceId, index, chunk.content, chunk.tokenEstimate,
          localText ? null : vectorLiteral(embeddings[index]), embeddingModel, localText ? 0 : embeddings[index].length,
          JSON.stringify(localText ? { retrievalMode: "local_text", retrievalProfile: LOCAL_TEXT_RETRIEVAL_PROFILE,
            ...(input.clientId !== DEMO_CLIENT_ID ? { retrievalScope: "instagram_hosted_test" } : {}) } : {})],
      );
    }
    await db.query(
      `update assistant_drafts
       set knowledge_changes = $2::jsonb, updated_by = $3, 
           edit_version = edit_version + 1, updated_at = now()
       where client_id = $1`,
      [input.clientId, JSON.stringify(currentChanges), input.actorUserId],
    );
  }, { isolationLevel: "serializable", retries: 2 });
  return sourceId;
}

export async function discardAssistantDraft(clientId: string, actorUserId: string): Promise<void> {
  await transaction(async (db) => {
    await db.query("delete from assistant_draft_chunks where client_id = $1", [clientId]);
    await db.query("delete from assistant_drafts where client_id = $1", [clientId]);
    await recordAuditLog({
      clientId, actorUserId, action: "assistant_draft.discarded",
      targetType: "client", targetId: clientId,
    }, db);
  });
}

export async function publishAssistantDraft(clientId: string, actorUserId: string): Promise<number> {
  return transaction(async (db) => {
    const actor = await db.query<{ role: string }>(
      "select role from users where id = $1", [actorUserId]);
    if (actor.rows[0]?.role !== "operator") {
      throw new Error("Only a Pronto operator may publish an approved assistant draft.");
    }
    const draftResult = await db.query<AssistantDraft>(
      "select * from assistant_drafts where client_id = $1 for update",
      [clientId],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new Error("There are no changes to publish.");
    await assertConfigurationApproved(db, clientId, "assistant", clientId, String(draft.edit_version));
    if (await liveFingerprint(db, clientId) !== draft.base_fingerprint) {
      throw new DraftConflictError();
    }
    for (const change of Object.values(draft.knowledge_changes)) {
      const suggestionId = change.metadata.suggestionId;
      const submissionId = change.metadata.submissionId;
      if (typeof submissionId === "string") {
        const submission = await db.query<{ status: string; current_revision: number;
          reviewed_revision: number | null; reviewed_by: string | null; target_source_id: string;
          submitted_by: string; action: string; source_type: string; title: string; content: string;
          content_sha256: string }>(
          `select s.status, s.current_revision, s.reviewed_revision, s.reviewed_by,
             s.target_source_id, s.submitted_by, s.action, s.source_type,
             r.title, r.content, r.content_sha256
           from knowledge_source_submissions s join knowledge_source_submission_revisions r
             on r.submission_id = s.id and r.client_id = s.client_id and r.revision = s.current_revision
           where s.id = $1 and s.client_id = $2 for update of s`, [submissionId, clientId]);
        const approved = submission.rows[0];
        if (!approved || approved.status !== "staged" || !approved.reviewed_by ||
            approved.current_revision !== change.metadata.submissionRevision ||
            approved.reviewed_revision !== approved.current_revision ||
            approved.target_source_id !== change.sourceId || approved.submitted_by !== change.authorUserId ||
            (approved.action === "archive" ? change.action !== "delete" :
              change.action !== "upsert" || approved.title !== change.title ||
              approved.content !== change.content || approved.source_type !== change.sourceType) ||
            approved.content_sha256 !== change.metadata.contentSha256) {
          throw new Error("A source submission changed after business review; publication is blocked.");
        }
      }
      if (typeof suggestionId === "string") {
        const suggestion = await db.query<{ status: string; current_revision: number;
          reviewed_revision: number | null; reviewed_by: string | null; target_source_id: string; created_by: string | null;
          title: string; content: string; reason: string; source_reference: string | null; outlet_name: string | null }>(
          `select s.status, s.current_revision, s.reviewed_revision, s.reviewed_by, s.target_source_id, s.created_by,
             r.title, r.content, r.reason, r.source_reference, r.outlet_name
           from knowledge_suggestions s join knowledge_suggestion_revisions r
             on r.suggestion_id = s.id and r.client_id = s.client_id and r.revision = s.current_revision
           where s.id = $1 and s.client_id = $2 for update of s`,
          [suggestionId, clientId]);
        const approved = suggestion.rows[0];
        if (!approved || !approved.reviewed_by || approved.status !== "staged" || change.action !== "upsert" ||
            approved.current_revision !== change.metadata.suggestionRevision ||
            approved.reviewed_revision !== approved.current_revision ||
            approved.target_source_id !== change.sourceId ||
            approved.title !== change.title || approved.content !== change.content ||
            (approved.created_by !== null && change.authorUserId !== approved.created_by) ||
            change.metadata.correctionReason !== approved.reason ||
            change.metadata.outletName !== approved.outlet_name ||
            change.metadata.sourceReference !== (approved.source_reference ?? "business_suggestion")) {
          throw new Error("A knowledge suggestion changed after business review; publication is blocked.");
        }
      }
      if (change.action === "delete") {
        const archived = await db.query<{ title: string; content: string; source_type: string; metadata: Record<string, unknown> }>(
          `update knowledge_sources set metadata = metadata || '{"archived":true}'::jsonb
           where id = $1 and client_id = $2 returning title, content, source_type, metadata`, [change.sourceId, clientId]);
        if (archived.rows[0]) {
          await db.query("delete from knowledge_chunks where source_id = $1 and client_id = $2", [change.sourceId, clientId]);
          await db.query(`insert into knowledge_source_versions
            (source_id, client_id, version_number, title, content, metadata, change_type, actor_user_id)
            select $1, $2, coalesce(max(version_number),0)+1, $3, $4, $5::jsonb, 'archived', $6
            from knowledge_source_versions where source_id = $1 and client_id = $2`,
            [change.sourceId, clientId, archived.rows[0].title, archived.rows[0].content,
              JSON.stringify(archived.rows[0].metadata), change.authorUserId ?? actorUserId]);
        }
        if (typeof submissionId === "string") await db.query(
          "update knowledge_source_submissions set status = 'published', published_at = now(), updated_at = now() where id = $1 and client_id = $2",
          [submissionId, clientId]);
        continue;
      }
      const existing = await db.query<{ id: string }>(
        "select id from knowledge_sources where id = $1 and client_id = $2",
        [change.sourceId, clientId],
      );
      if (existing.rowCount) {
        await db.query(
          "update knowledge_sources set title = $3, content = $4, source_type = $5, metadata = $6::jsonb where id = $1 and client_id = $2",
          [change.sourceId, clientId, change.title, change.content, change.sourceType, JSON.stringify(change.metadata)],
        );
        await db.query("delete from knowledge_chunks where source_id = $1 and client_id = $2", [
          change.sourceId, clientId,
        ]);
      } else {
        await db.query(
          `insert into knowledge_sources (id, client_id, title, source_type, content, metadata)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [change.sourceId, clientId, change.title, change.sourceType, change.content, JSON.stringify(change.metadata)],
        );
      }
      await db.query(
        `insert into knowledge_chunks
         (source_id, client_id, chunk_index, content, token_estimate, embedding, embedding_model, embedding_dimensions, metadata)
         select source_id, client_id, chunk_index, content, token_estimate, embedding, embedding_model, embedding_dimensions, metadata
         from assistant_draft_chunks where client_id = $1 and source_id = $2`,
        [clientId, change.sourceId],
      );
      await db.query(
        `insert into knowledge_source_versions
         (source_id, client_id, version_number, title, content, metadata, change_type, actor_user_id)
         select $1, $2, coalesce(max(version_number), 0) + 1, $3, $4, $5::jsonb, $6, $7
         from knowledge_source_versions where source_id = $1 and client_id = $2`,
        [change.sourceId, clientId, change.title, change.content, JSON.stringify(change.metadata),
          existing.rowCount ? "updated" : "created", change.authorUserId ?? actorUserId],
      );
      if (typeof suggestionId === "string") {
        await db.query(
          `update knowledge_suggestions set status = 'published', updated_at = now()
           where id = $1 and client_id = $2`, [suggestionId, clientId]);
        await db.query(
          `update knowledge_review_items set status = 'resolved', updated_at = now()
           where suggestion_id = $1 and client_id = $2 and status = 'suggested'`, [suggestionId, clientId]);
      }
      if (typeof submissionId === "string") await db.query(
        "update knowledge_source_submissions set status = 'published', published_at = now(), updated_at = now() where id = $1 and client_id = $2",
        [submissionId, clientId]);
    }
    if (draft.voice) {
      const voice = draft.voice;
      await db.query(
        `insert into brand_voice_documents (client_id, title, content, attributes, source_notes)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (client_id) do update set
           title = excluded.title, content = excluded.content,
           attributes = excluded.attributes, source_notes = excluded.source_notes, updated_at = now()`,
        [clientId, voice.title, voice.content, JSON.stringify(voice.attributes ?? {}), voice.sourceNotes ?? null],
      );
      await db.query("update clients set brand_voice = $2, updated_at = now() where id = $1", [
        clientId, voice.content,
      ]);
      await db.query("delete from brand_voice_examples where client_id = $1", [clientId]);
      for (const example of voice.examples) {
        await db.query(
          `insert into brand_voice_examples
           (client_id, customer_message, ideal_response, notes, is_active)
           values ($1, $2, $3, $4, $5)`,
          [clientId, example.customerMessage, example.idealResponse, example.notes, example.active],
        );
      }
    }
    if (draft.config) {
      const config = draft.config;
      const before = await db.query("select * from agent_configs where client_id = $1 for update", [clientId]);
      if (!before.rows[0]) throw new Error("Agent configuration is missing.");
      const after = await db.query(
        `update agent_configs set retrieval_threshold = $2, prompt_preamble = $3,
         escalation_rules = $4::jsonb, response_provider = $5, response_model = $6,
         embedding_provider = $7, embedding_model = $8, updated_at = now()
         where client_id = $1 returning *`,
        [clientId, config.retrievalThreshold, config.promptPreamble, JSON.stringify(config.escalationRules),
          config.responseProvider, config.responseModel, config.embeddingProvider, config.embeddingModel],
      );
      await db.query(
        `insert into agent_config_changes
         (client_id, actor_user_id, previous_config, new_config, change_reason)
         values ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [clientId, actorUserId, JSON.stringify(before.rows[0]), JSON.stringify(after.rows[0]),
          config.changeReason?.trim() || null],
      );
    }
    if (draft.flow) {
      const flow = validateAndNormalizeTriageFlow(draft.flow);
      const rules = compileTriageFlowToEscalationRules(flow.nodes);
      await db.query(
        `insert into triage_flows (client_id, nodes, edges, compiled_escalation_rules, published_at)
         values ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
         on conflict (client_id) do update set
           nodes = excluded.nodes, edges = excluded.edges,
           compiled_escalation_rules = excluded.compiled_escalation_rules,
           version = triage_flows.version + 1, published_at = now(), updated_at = now()`,
        [clientId, JSON.stringify(flow.nodes), JSON.stringify(flow.edges), JSON.stringify(rules)],
      );
      await db.query(
        "update agent_configs set escalation_rules = $2::jsonb, updated_at = now() where client_id = $1",
        [clientId, JSON.stringify(rules)],
      );
    }
    const revisionResult = await db.query<{ revision: number }>(
      `insert into assistant_publications (client_id, revision, published_at, published_by)
       values ($1, 1, now(), $2)
       on conflict (client_id) do update set revision = assistant_publications.revision + 1,
         published_at = now(), published_by = excluded.published_by
       returning revision`,
      [clientId, actorUserId],
    );
    await db.query("delete from assistant_draft_chunks where client_id = $1", [clientId]);
    await db.query("delete from assistant_drafts where client_id = $1", [clientId]);
    await recordAuditLog({
      clientId, actorUserId, action: "assistant_draft.published",
      targetType: "client", targetId: clientId,
      metadata: { revision: revisionResult.rows[0].revision },
    }, db);
    return revisionResult.rows[0].revision;
  }, { isolationLevel: "serializable", retries: 2 });
}

async function liveFingerprint(db: Queryable, clientId: string): Promise<string> {
  const client = await db.query("select brand_voice from clients where id = $1", [clientId]);
  const sources = await db.query("select id, title, content, source_type, metadata from knowledge_sources where client_id = $1 order by id", [clientId]);
  const voice = await db.query("select title, content, attributes, source_notes from brand_voice_documents where client_id = $1", [clientId]);
  const examples = await db.query("select customer_message, ideal_response, notes, is_active from brand_voice_examples where client_id = $1 order by id", [clientId]);
  const flow = await db.query("select nodes, edges, version from triage_flows where client_id = $1", [clientId]);
  const config = await db.query("select prompt_preamble, escalation_rules from agent_configs where client_id = $1", [clientId]);
  return createHash("sha256")
    .update(JSON.stringify([client.rows, sources.rows, voice.rows, examples.rows, flow.rows, config.rows]))
    .digest("hex");
}
