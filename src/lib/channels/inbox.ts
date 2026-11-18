import { processingFailure } from "@/lib/agent/processing-error";
import { query, transaction, type Queryable } from "@/lib/db";
import type { NormalizedInboundMessage } from "@/lib/channels/types";
import type { Channel, Conversation, Message } from "@/lib/types";

export type InboundJob = {
  id: string;
  client_id: string;
  channel_id: string;
  conversation_id: string;
  message_id: string;
  status: "pending" | "processing" | "failed" | "completed" | "skipped" | "dead";
  attempt_count: number;
  sequence: string;
};

export type IngestedInbound = {
  duplicate: boolean;
  jobId: string;
  conversationId: string;
  messageId: string;
};

const MAX_ATTEMPTS = 5;

export async function ingestInboundMessage(inbound: NormalizedInboundMessage,
  existingTransaction?: Queryable): Promise<IngestedInbound> {
  if (!inbound.externalMessageId || !inbound.externalThreadId) {
    throw new Error("Inbound provider identity is missing.");
  }
  const ingest = async (db: Queryable) => {
    const channelResult = await db.query<Channel>(
      "select * from channels where id = $1 and kind = $2 for share",
      [inbound.channelId, inbound.channelKind],
    );
    const channel = channelResult.rows[0];
    if (!channel) throw new Error("Inbound channel not found.");
    if (channel.status !== "active") throw new Error("Inbound channel is disabled or inactive.");

    const conversation = await db.query<Conversation>(
      `insert into conversations (client_id, channel_id, external_thread_id, customer_name, customer_handle)
       values ($1, $2, $3, $4, $5)
       on conflict (channel_id, external_thread_id) where deleted_at is null do update set
         customer_name = coalesce(excluded.customer_name, conversations.customer_name),
         customer_handle = excluded.customer_handle, last_message_at = now()
       returning *`,
      [channel.client_id, channel.id, inbound.externalThreadId,
        inbound.customerName ?? null, inbound.customerHandle],
    );
    const inserted = await db.query<Message>(
      `insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
       values ($1, $2, $3, $4, 'customer', $5, $6)
       on conflict (channel_id, external_message_id) do nothing returning *`,
      [conversation.rows[0].id, channel.client_id, channel.id, inbound.externalMessageId,
        inbound.text, { raw: inbound.raw, channelKind: inbound.channelKind,
          aiPausedAtIngestion: conversation.rows[0].status !== "active",
          providerOccurredAt: inbound.occurredAt ?? null,
          unsupportedMediaType: inbound.unsupportedMediaType ?? null }],
    );
    const message = inserted.rows[0] ?? (await db.query<Message>(
      "select * from messages where channel_id = $1 and external_message_id = $2 and client_id = $3",
      [channel.id, inbound.externalMessageId, channel.client_id],
    )).rows[0];
    if (!message || message.conversation_id !== conversation.rows[0].id || message.sender_role !== "customer") {
      throw new Error("Inbound provider message identity conflicts with an existing message.");
    }
    const job = await db.query<InboundJob>(
      `insert into inbound_jobs (client_id, channel_id, conversation_id, message_id)
       values ($1, $2, $3, $4)
       on conflict (message_id) do update set updated_at = inbound_jobs.updated_at
       returning *`,
      [channel.client_id, channel.id, conversation.rows[0].id, message.id],
    );
    return {
      duplicate: !inserted.rows[0], jobId: job.rows[0].id,
      conversationId: conversation.rows[0].id, messageId: message.id,
    };
  };
  // the channel share lock, conversation upsert and unique message/job keys
  // serialize this ingestion without repeatable snapshots aborting duplicates.
  return existingTransaction ? ingest(existingTransaction) : transaction(ingest);
}

export async function ingestInboundMessages(messages: NormalizedInboundMessage[]): Promise<{
  ok: true; accepted: number; duplicates: number; jobIds: string[];
}> {
  const jobIds: string[] = [];
  let duplicates = 0;
  for (const message of messages) {
    const ingested = await ingestInboundMessage(message);
    jobIds.push(ingested.jobId);
    if (ingested.duplicate) duplicates += 1;
  }
  return { ok: true, accepted: messages.length, duplicates, jobIds };
}

export async function claimInboundJob(input: { jobId?: string; leaseSeconds?: number; clientId?: string; channelId?: string } = {}): Promise<InboundJob | null> {
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 120, 10), 900);
  const result = await query<InboundJob>(
    `with candidate as (
       select j.id from inbound_jobs j
       where ($1::uuid is null or j.id = $1::uuid)
         and ($4::uuid is null or j.client_id = $4::uuid)
         and ($5::uuid is null or j.channel_id = $5::uuid)
         and j.attempt_count < $2
         and ((j.status in ('pending', 'failed') and j.available_at <= now())
              or (j.status = 'processing' and j.lease_expires_at <= now()))
         and not exists (
           select 1 from inbound_jobs earlier
           where earlier.conversation_id = j.conversation_id
             and earlier.sequence < j.sequence
             and earlier.status not in ('completed', 'skipped')
         )
       order by j.sequence
       for update of j skip locked limit 1
     )
     update inbound_jobs j set status = 'processing', attempt_count = attempt_count + 1,
       lease_expires_at = now() + make_interval(secs => $3::int), updated_at = now()
     from candidate where j.id = candidate.id returning j.*`,
    [input.jobId ?? null, MAX_ATTEMPTS, leaseSeconds, input.clientId ?? null, input.channelId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function finishInboundJob(job: InboundJob, outcome: "completed" | "skipped"): Promise<void> {
  await query(
    `update inbound_jobs set status = $3, completed_at = now(), lease_expires_at = null,
       last_error = null, failure_code = null, failure_provider = null, updated_at = now()
     where id = $1 and client_id = $2 and status = 'processing' and attempt_count = $4`,
    [job.id, job.client_id, outcome, job.attempt_count],
  );
}

export async function failInboundJob(job: InboundJob, error: unknown): Promise<void> {
  const failure = processingFailure(error);
  const delaySeconds = Math.max(Math.min(300, 5 * 2 ** (job.attempt_count - 1)), failure.delaySeconds ?? 0);
  await query(
    `update inbound_jobs set status = case when $9 and created_at < now()-interval '15 minutes' then 'dead' else $3 end,
       attempt_count=case when $9 then greatest(0,attempt_count-1) else attempt_count end,
       available_at = now() + make_interval(secs => $4::int), lease_expires_at = null,
       last_error = $5, failure_code=$7, failure_provider=$8, updated_at = now()
     where id = $1 and client_id = $2 and status = 'processing' and attempt_count = $6`,
    [job.id, job.client_id, !failure.retryable || (!failure.deferred && job.attempt_count >= MAX_ATTEMPTS) ? "dead" : "failed",
      delaySeconds, error instanceof Error ? `Processing failed (${error.name}).` : "Processing failed.",
      job.attempt_count, failure.code, failure.provider, Boolean(failure.deferred)],
  );
}

export async function expireExhaustedInboundLeases(): Promise<number> {
  const result = await query(
    `update inbound_jobs set status = 'dead', lease_expires_at = null, updated_at = now(),
       last_error = coalesce(last_error, 'Worker lease expired after final attempt.')
     where status = 'processing' and attempt_count >= $1 and lease_expires_at <= now()`,
    [MAX_ATTEMPTS],
  );
  return result.rowCount ?? 0;
}
