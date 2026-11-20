import {runtimeConfig,runtimeVoice} from '@/lib/self-serve/runtime';
import { query, transaction } from "@/lib/db";
import type { BrandVoiceDocument, BrandVoiceExample, Client } from "@/lib/types";
import { compileVoiceStyle, VOICE_EXAMPLE_LIMIT, type VoiceStyle } from "@/lib/voice-style";

export type BrandVoiceProfile = {
  document: BrandVoiceDocument | null;
  examples: BrandVoiceExample[];
};

export async function getBrandVoiceProfile(
  clientId: string,
): Promise<BrandVoiceProfile> {
  const [documentResult, examplesResult] = await Promise.all([
    query<BrandVoiceDocument>(
      "select * from brand_voice_documents where client_id = $1",
      [clientId],
    ),
    query<BrandVoiceExample>(
      `
        select *
        from brand_voice_examples
        where client_id = $1
        order by is_active desc, created_at desc, id
      `,
      [clientId],
    ),
  ]);

  return {
    document: documentResult.rows[0] ?? null,
    examples: examplesResult.rows,
  };
}

export async function getPromptBrandVoiceProfile(
  clientId: string,
  limit = VOICE_EXAMPLE_LIMIT,
): Promise<BrandVoiceProfile> {
  const config=await runtimeConfig(clientId);if(config)return runtimeVoice(config);
  const [documentResult, examplesResult] = await Promise.all([
    query<BrandVoiceDocument>(
      "select * from brand_voice_documents where client_id = $1",
      [clientId],
    ),
    query<BrandVoiceExample>(
      `
        select *
        from brand_voice_examples
        where client_id = $1 and is_active = true
        order by created_at desc, id
        limit $2
      `,
      [clientId, limit],
    ),
  ]);

  return {
    document: documentResult.rows[0] ?? null,
    examples: examplesResult.rows,
  };
}

export async function updateBrandVoiceDocument(input: {
  clientId: string;
  title: string;
  content: string;
  attributes: Record<string, unknown>;
  sourceNotes?: string | null;
  actorUserId: string;
}): Promise<BrandVoiceDocument | null> {
  return transaction(async (client) => {
    const clientResult = await client.query<Client>(
      "select * from clients where id = $1",
      [input.clientId],
    );
    if (!clientResult.rows[0]) {
      return null;
    }

    const updated = await client.query<BrandVoiceDocument>(
      `
        insert into brand_voice_documents (
          client_id,
          title,
          content,
          attributes,
          source_notes
        )
        values ($1, $2, $3, $4, $5)
        on conflict (client_id) do update set
          title = excluded.title,
          content = excluded.content,
          attributes = excluded.attributes,
          source_notes = excluded.source_notes,
          updated_at = now()
        returning *
      `,
      [
        input.clientId,
        input.title,
        input.content,
        input.attributes,
        input.sourceNotes ?? null,
      ],
    );

    await client.query(
      `
        update clients
        set brand_voice = $2,
            updated_at = now()
        where id = $1
      `,
      [input.clientId, input.content],
    );

    await client.query(
      `
        insert into audit_logs (client_id, actor_user_id, action, target_type, target_id, metadata)
        values ($1, $2, 'brand_voice.updated', 'brand_voice_document', $3, $4)
      `,
      [
        input.clientId,
        input.actorUserId,
        updated.rows[0].id,
        { title: input.title },
      ],
    );

    return updated.rows[0];
  });
}

export async function addBrandVoiceExample(input: {
  clientId: string;
  customerMessage: string;
  idealResponse: string;
  notes?: string | null;
  actorUserId: string;
}): Promise<BrandVoiceExample | null> {
  return transaction(async (client) => {
    const clientResult = await client.query<Client>(
      "select * from clients where id = $1",
      [input.clientId],
    );
    if (!clientResult.rows[0]) {
      return null;
    }

    const inserted = await client.query<BrandVoiceExample>(
      `
        insert into brand_voice_examples (
          client_id,
          customer_message,
          ideal_response,
          notes
        )
        values ($1, $2, $3, $4)
        returning *
      `,
      [
        input.clientId,
        input.customerMessage,
        input.idealResponse,
        input.notes ?? null,
      ],
    );

    await client.query(
      `
        insert into audit_logs (client_id, actor_user_id, action, target_type, target_id, metadata)
        values ($1, $2, 'brand_voice_example.created', 'brand_voice_example', $3, $4)
      `,
      [
        input.clientId,
        input.actorUserId,
        inserted.rows[0].id,
        { customerMessage: input.customerMessage.slice(0, 120) },
      ],
    );

    return inserted.rows[0];
  });
}

export async function setBrandVoiceExampleActive(input: {
  clientId: string;
  exampleId: string;
  isActive: boolean;
  actorUserId: string;
}): Promise<boolean> {
  const result = await query(
    `
      update brand_voice_examples
      set is_active = $3,
          updated_at = now()
      where id = $1 and client_id = $2
    `,
    [input.exampleId, input.clientId, input.isActive],
  );
  if (!result.rowCount) {
    return false;
  }
  await query(
    `
      insert into audit_logs (client_id, actor_user_id, action, target_type, target_id, metadata)
      values ($1, $2, 'brand_voice_example.toggled', 'brand_voice_example', $3, $4)
    `,
    [
      input.clientId,
      input.actorUserId,
      input.exampleId,
      { isActive: input.isActive },
    ],
  );
  return true;
}

export async function deleteBrandVoiceExample(input: {
  clientId: string;
  exampleId: string;
  actorUserId: string;
}): Promise<boolean> {
  const result = await query(
    "delete from brand_voice_examples where id = $1 and client_id = $2",
    [input.exampleId, input.clientId],
  );
  if (!result.rowCount) {
    return false;
  }
  await query(
    `
      insert into audit_logs (client_id, actor_user_id, action, target_type, target_id, metadata)
      values ($1, $2, 'brand_voice_example.deleted', 'brand_voice_example', $3, '{}'::jsonb)
    `,
    [input.clientId, input.actorUserId, input.exampleId],
  );
  return true;
}

export function parseBrandVoiceAttributes(value: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Brand voice attributes must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function buildBrandVoiceDraft(input: {
  clientName: string;
  sourceText: string;
}): {
  title: string;
  content: string;
  attributes: Record<string, unknown>;
  sourceNotes: string;
} {
  const text = input.sourceText.trim();
  const lowered = text.toLowerCase();
  const style: VoiceStyle = {
    tone: /friendly|warm/.test(lowered) ? "warm" : "courteous",
    length: /quick|short|concise/.test(lowered) ? "concise" : "balanced",
  };
  return {
    title: `${input.clientName} reply style`,
    content: compileVoiceStyle(style),
    attributes: { style },
    sourceNotes: `Prepared from ${Math.min(text.length, 5000)} characters of operator-provided style samples.`,
  };
}
