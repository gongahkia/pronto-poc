import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction, type Queryable } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import {
  voicePresets,
  defaultHandovers,
  type Voice,
  type Handovers,
  type Alerts,
  type Industry,
} from "./catalog";
export class SelfServeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "SelfServeError";
  }
}
export type Settings = {
  client_id: string;
  enabled: boolean;
  industry: Industry;
  version: string;
  rules_revision: string;
  voice: Voice;
  handovers: Handovers;
  alerts: Alerts;
};
export type Source = {
  id: string;
  client_id: string;
  type: "text" | "file" | "url";
  label: string;
  status: "processing" | "ready" | "failed";
  revision: number;
  raw_text: string | null;
  url: string | null;
  extracted_text: string | null;
  segments: Array<{ ref: string; text: string }> | null;
  transient_file: unknown;
  file_meta: Record<string, unknown> | null;
  error: string | null;
  deleted_at: Date | null;
  created_at: Date;
};
export type Rule = {
  id: string;
  client_id: string;
  source_id: string;
  text: string;
  ref: string;
  topic: string | null;
  position: number;
  revision: number;
  checked: boolean;
  deleted_at: Date | null;
  evidence: string | null;
};
export async function getSettings(clientId: string, db: Queryable = { query }) {
  return (
    (
      await db.query<Settings>(
        "select * from selfserve_settings where client_id=$1",
        [clientId],
      )
    ).rows[0] ?? null
  );
}
export async function lockSettings(db: Queryable, clientId: string) {
  const s = (
    await db.query<Settings>(
      "select * from selfserve_settings where client_id=$1 for update",
      [clientId],
    )
  ).rows[0];
  if (!s)
    throw new SelfServeError(
      "The self-serve workspace has not been provisioned.",
      503,
    );
  return s;
}
export async function touch(db: Queryable, clientId: string, rules = false) {
  await db.query(
    `update selfserve_settings set version=version+1,rules_revision=rules_revision+$2,updated_at=now() where client_id=$1`,
    [clientId, rules ? 1 : 0],
  );
}
export function checkRevision(s: Settings, version: unknown) {
  if (String(version) !== String(s.version))
    throw new SelfServeError(
      "This workspace changed. Reload the latest version before saving.",
      409,
    );
}
export async function queueJob(
  db: Queryable,
  clientId: string,
  actorId: string,
  kind: string,
  target: string,
  revision: number,
  payload: unknown = {},
) {
  const id = randomUUID();
  return (
    await db.query<{ id: string }>(
      `insert into selfserve_jobs(id,client_id,actor_id,kind,target_id,revision,payload) values($1,$2,$3,$4,$5,$6,$7)
 on conflict(client_id,kind,target_id,revision) do update set updated_at=selfserve_jobs.updated_at returning id`,
      [id, clientId, actorId, kind, target, revision, payload],
    )
  ).rows[0].id;
}
export async function initializeSelfServe(clientId: string, actorId: string) {
  return transaction(async (db) => {
    const client = (
      await db.query<{
        id: string;
        vertical: string;
        business_profile: Record<string, unknown>;
      }>(
        "select id,vertical,business_profile from clients where id=$1 for update",
        [clientId],
      )
    ).rows[0];
    if (!client) throw new SelfServeError("Business not found.", 404);
    if (await getSettings(clientId, db)) return;
    const voice = (
      await db.query<{ content: string }>(
        "select content from brand_voice_documents where client_id=$1",
        [clientId],
      )
    ).rows[0];
    const profile: Voice = voice?.content
      ? {
          mode: "custom",
          preset_id: "small",
          custom_notes: [voice.content],
          custom_origin: "existing",
        }
      : { mode: "preset", preset_id: "small", custom_notes: [] };
    await db.query(
      `insert into selfserve_settings(client_id,industry,voice,handovers,alerts) values($1,$2,$3,$4,$5)`,
      [
        clientId,
        client.business_profile.industry === "dental" ? "dental" : "restaurant",
        profile,
        defaultHandovers(),
        {
          whatsapp_enabled: false,
          email_enabled: false,
          whatsapp_number: "",
          email_address: "",
        },
      ],
    );
    const sources = (
      await db.query<{
        id: string;
        title: string;
        content: string;
        source_type: string;
        metadata: Record<string, unknown>;
      }>(
        "select id,title,content,source_type,metadata from knowledge_sources where client_id=$1 and metadata->>'archived' is distinct from 'true' order by created_at,id",
        [clientId],
      )
    ).rows;
    for (const source of sources) {
      const id = randomUUID();
      await db.query(
        `insert into selfserve_sources(id,client_id,type,label,raw_text,legacy_source_id) values($1,$2,'text',$3,$4,$5)`,
        [id, clientId, source.title, source.content, source.id],
      );
      await queueJob(db, clientId, actorId, "source", id, 1);
    }
    if (!sources.length)
      await db.query(
        "update selfserve_settings set enabled=true where client_id=$1",
        [clientId],
      );
    await recordAuditLog(
      {
        clientId,
        actorUserId: actorId,
        action: "selfserve.initialized",
        targetType: "client",
        targetId: clientId,
        metadata: {
          legacySourcesRetained: sources.length,
          existingVoiceRetained: Boolean(voice),
        },
      },
      db,
    );
  });
}
export async function snapshot(clientId: string) {
  const [settings, sources, rules, conflicts, jobs] = await Promise.all([
    getSettings(clientId),
    query(
      `select id,type,label,status,revision,file_meta,error,created_at from selfserve_sources where client_id=$1 and deleted_at is null order by created_at desc,id`,
      [clientId],
    ),
    query(
      `select r.id,r.source_id,r.text,r.ref,r.topic,r.position,r.checked,r.revision,r.edited_by_owner,
  r.checked and not exists(select 1 from selfserve_conflicts c where c.client_id=$1 and c.status='open' and (c.rule_a=r.id or c.rule_b=r.id)) live
  from selfserve_rules r join selfserve_sources s on s.id=r.source_id and s.client_id=r.client_id
  where r.client_id=$1 and r.deleted_at is null and s.deleted_at is null order by r.position,r.id`,
      [clientId],
    ),
    query(
      `select id,rule_a,rule_b,topic,explanation from selfserve_conflicts where client_id=$1 and status='open'`,
      [clientId],
    ),
    query(
      `select id,kind,status,error,created_at from selfserve_jobs where client_id=$1 and created_at>now()-interval '1 day' order by created_at desc limit 30`,
      [clientId],
    ),
  ]);
  return {
    settings,
    sources: sources.rows,
    rules: rules.rows,
    conflicts: conflicts.rows,
    jobs: jobs.rows,
  };
}
const notes = z.array(z.string().trim().min(1).max(1600)).min(1).max(20);
export async function saveVoice(
  clientId: string,
  actorId: string,
  input: {
    version: unknown;
    mode: unknown;
    preset_id?: unknown;
    custom_notes?: unknown;
    custom_origin?: unknown;
    sessionId?: string;
  },
) {
  return transaction(async (db) => {
    const s = await lockSettings(db, clientId);
    checkRevision(s, input.version);
    const mode = z.enum(["preset", "custom"]).parse(input.mode);
    const voice: Voice =
      mode === "preset"
        ? {
            ...s.voice,
            mode,
            preset_id: z
              .enum(voicePresets.map((p) => p.id))
              .parse(input.preset_id),
          }
        : {
            ...s.voice,
            mode,
            custom_notes: notes.parse(
              Array.isArray(input.custom_notes)
                ? input.custom_notes.filter(
                    (n) => typeof n === "string" && n.trim(),
                  )
                : [],
            ),
            custom_origin: z
              .enum(["conversation", "upload", "existing"])
              .parse(input.custom_origin),
          };
    if (input.sessionId) {
      const saved = await db.query(
        `update selfserve_voice_sessions set status='saved',review_text=null,replies='[]',transient_file=null,updated_at=now() where client_id=$1 and id=$2 and actor_id=$3 and status='ready' and expires_at>now() returning id`,
        [clientId, input.sessionId, actorId],
      );
      if (!saved.rowCount)
        throw new SelfServeError(
          "This voice session is no longer ready to save.",
          409,
        );
    }
    await db.query(
      "update selfserve_settings set voice=$2 where client_id=$1",
      [clientId, voice],
    );
    await touch(db, clientId);
    await recordAuditLog(
      {
        clientId,
        actorUserId: actorId,
        action: "selfserve.voice_saved",
        targetType: "client",
        targetId: clientId,
        metadata: { mode, preset: voice.preset_id },
      },
      db,
    );
  });
}
export async function removeRule(
  clientId: string,
  actorId: string,
  id: string,
  version: unknown,
  keep = false,
) {
  return transaction(async (db) => {
    const s = await lockSettings(db, clientId);
    checkRevision(s, version);
    const rule = (
      await db.query<Rule>(
        "select * from selfserve_rules where client_id=$1 and id=$2 and deleted_at is null",
        [clientId, id],
      )
    ).rows[0];
    if (!rule) throw new SelfServeError("Rule not found.", 404);
    const ids = keep
      ? (
          await db.query<{ id: string }>(
            `select case when rule_a=$2 then rule_b else rule_a end id from selfserve_conflicts where client_id=$1 and status='open' and (rule_a=$2 or rule_b=$2)`,
            [clientId, id],
          )
        ).rows.map((r) => r.id)
      : [id];
    if (ids.length) {
      await db.query(
        "update selfserve_rules set deleted_at=now(),revision=revision+1,updated_at=now() where client_id=$1 and id=any($2::uuid[])",
        [clientId, ids],
      );
      await db.query(
        `update selfserve_conflicts set status='resolved',resolved_by=$3,resolved_at=now(),updated_at=now() where client_id=$1 and status='open' and (rule_a=any($2::uuid[]) or rule_b=any($2::uuid[]))`,
        [clientId, ids, keep ? "keep" : "delete"],
      );
    }
    await touch(db, clientId, true);
    await recordAuditLog(
      {
        clientId,
        actorUserId: actorId,
        action: keep ? "selfserve.rule_kept" : "selfserve.rule_deleted",
        targetType: "rule",
        targetId: id,
        metadata: { affectedRuleIds: ids },
      },
      db,
    );
  });
}
export async function editRule(
  clientId: string,
  actorId: string,
  id: string,
  text: unknown,
  version: unknown,
) {
  const value = z.string().trim().min(1).max(1600).parse(text);
  return transaction(async (db) => {
    const s = await lockSettings(db, clientId);
    checkRevision(s, version);
    const row = (
      await db.query<{ revision: number }>(
        `update selfserve_rules set text=$3,edited_by_owner=true,checked=false,revision=revision+1,updated_at=now() where client_id=$1 and id=$2 and deleted_at is null returning revision`,
        [clientId, id, value],
      )
    ).rows[0];
    if (!row) throw new SelfServeError("Rule not found.", 404);
    await touch(db, clientId, true);
    await queueJob(db, clientId, actorId, "rule", id, row.revision);
    await recordAuditLog(
      {
        clientId,
        actorUserId: actorId,
        action: "selfserve.rule_edited",
        targetType: "rule",
        targetId: id,
        metadata: { revision: row.revision },
      },
      db,
    );
  });
}
export async function removeSource(
  clientId: string,
  actorId: string,
  id: string,
  version: unknown,
) {
  return transaction(async (db) => {
    const s = await lockSettings(db, clientId);
    checkRevision(s, version);
    const row = await db.query(
      `update selfserve_sources set deleted_at=now(),transient_file=null,revision=revision+1,updated_at=now() where client_id=$1 and id=$2 and deleted_at is null returning id`,
      [clientId, id],
    );
    if (!row.rowCount) throw new SelfServeError("Source not found.", 404);
    const ids = (
      await db.query<{ id: string }>(
        "update selfserve_rules set deleted_at=now(),revision=revision+1 where client_id=$1 and source_id=$2 and deleted_at is null returning id",
        [clientId, id],
      )
    ).rows.map((r) => r.id);
    await db.query(
      `update selfserve_conflicts set status='resolved',resolved_by='source_removed',resolved_at=now(),updated_at=now() where client_id=$1 and status='open' and (rule_a=any($2::uuid[]) or rule_b=any($2::uuid[]))`,
      [clientId, ids],
    );
    await db.query(
      "update selfserve_settings set enabled=true where client_id=$1 and not exists(select 1 from selfserve_sources where client_id=$1 and legacy_source_id is not null and deleted_at is null and status<>'ready')",
      [clientId],
    );
    await touch(db, clientId, true);
    await recordAuditLog(
      {
        clientId,
        actorUserId: actorId,
        action: "selfserve.source_removed",
        targetType: "source",
        targetId: id,
      },
      db,
    );
  });
}
