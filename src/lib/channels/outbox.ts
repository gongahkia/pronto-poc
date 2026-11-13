import { sendChannelText } from "@/lib/channels/dispatch";
import { policyFromOutboundMetadata } from "@/lib/channels/policy";
import { query, transaction, type Queryable } from "@/lib/db";
import { recordErrorEvent } from "@/lib/error-tracking";
import { logInfo, logWarn, redactErrorMessage } from "@/lib/logger";
import { AmbiguousProviderAcceptanceError, ChannelPolicyError, ProviderSendError } from "@/lib/channels/provider-error";

export type OutboundMessage = {
  id: string;
  client_id: string;
  conversation_id: string | null;
  escalation_id: string | null;
  channel_id: string;
  external_thread_id: string;
  body: string;
  status: "pending" | "sending" | "sent" | "failed" | "suppressed" | "uncertain" | "dead";
  attempt_count: number;
  last_error: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
};

export type EnqueueOutboundInput = {
  clientId: string;
  conversationId?: string | null;
  escalationId?: string | null;
  channelId: string;
  externalThreadId: string;
  body: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export type OutboundFlushResult =
  | { status: "sent"; outboundMessageId: string }
  | { status: "failed"; outboundMessageId: string; error: string }
  | { status: "skipped"; outboundMessageId: string; reason: string };

export type OutboundFlushOptions = {
  requestId?: string;
  clientId?: string;
  staleSendingMinutes?: number;
  maxAttempts?: number;
};

export type OutboundRetryBatchInput = OutboundFlushOptions & {
  limit?: number;
};

export type OutboundRetryBatchResult = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  results: OutboundFlushResult[];
};

const DEFAULT_STALE_SENDING_MINUTES = normalizePositiveInteger(
  Number(process.env.PRONTO_OUTBOX_STALE_SENDING_MINUTES), 10);
const DEFAULT_MAX_ATTEMPTS = normalizePositiveInteger(Number(process.env.PRONTO_OUTBOX_MAX_ATTEMPTS), 5);
const DEFAULT_RETRY_LIMIT = normalizePositiveInteger(Number(process.env.PRONTO_OUTBOX_RETRY_LIMIT), 25);

export async function enqueueOutboundMessage(
  db: Queryable,
  input: EnqueueOutboundInput,
): Promise<OutboundMessage> {
  const result = await db.query<OutboundMessage>(
    `
      insert into outbound_messages (
        client_id,
        conversation_id,
        escalation_id,
        channel_id,
        external_thread_id,
        body,
        idempotency_key,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (client_id, idempotency_key) do update set
        idempotency_key = excluded.idempotency_key
      returning *
    `,
    [
      input.clientId,
      input.conversationId ?? null,
      input.escalationId ?? null,
      input.channelId,
      input.externalThreadId,
      input.body,
      input.idempotencyKey,
      input.metadata ?? {},
    ],
  );

  return result.rows[0];
}

export async function flushOutboundMessage(
  outboundMessageId: string,
  options: OutboundFlushOptions = {},
): Promise<OutboundFlushResult> {
  const maxAttempts = normalizePositiveInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
  );
  const claimed = await query<OutboundMessage>(
    `
      update outbound_messages
      set status = 'sending',
          attempt_count = attempt_count + 1,
          updated_at = now()
      where id = $1
        and ($2::uuid is null or client_id = $2::uuid)
        and attempt_count < $3
        and status in ('pending', 'failed')
      returning *
    `,
    [outboundMessageId, options.clientId ?? null, maxAttempts],
  );
  const outbound = claimed.rows[0];
  if (!outbound) {
    logInfo("outbox.flush_skipped", {
      requestId: options.requestId,
      outboundMessageId,
      reason: "not_retryable",
    });
    return {
      status: "skipped",
      outboundMessageId,
      reason: "Outbound message is not retryable.",
    };
  }

  logInfo("outbox.flush_claimed", {
    requestId: options.requestId,
    outboundMessageId: outbound.id,
    clientId: outbound.client_id,
    conversationId: outbound.conversation_id,
    escalationId: outbound.escalation_id,
    channelId: outbound.channel_id,
    attemptCount: outbound.attempt_count,
  });

  let sendAccepted = false;
  try {
    const policy = policyFromOutboundMetadata(outbound.metadata);
    const send = async () => {
      const result = await sendChannelText({
        channelId: outbound.channel_id, clientId: outbound.client_id,
        externalThreadId: outbound.external_thread_id, text: outbound.body,
        ...(policy ? { policy } : {}),
      });
      sendAccepted = true;
      return result;
    };
    if (outbound.metadata.purpose === "agent_answer" && outbound.conversation_id) {
      const allowed = await transaction(async (db) => {
        const conversation = await db.query<{ status: string }>(
          "select status from conversations where id = $1 and client_id = $2 for share",
          [outbound.conversation_id, outbound.client_id],
        );
        const open = await db.query<{ id: string }>(
          "select id from escalations where conversation_id = $1 and client_id = $2 and (status='claimed' or (status='open' and not allow_ai_followups)) limit 1",
          [outbound.conversation_id, outbound.client_id],
        );
        if (conversation.rows[0]?.status !== "active" || open.rows[0]) {
          await db.query(
            "update outbound_messages set status = 'suppressed', last_error = 'Human-owned conversation', updated_at = now() where id = $1 and client_id = $2",
            [outbound.id, outbound.client_id],
          );
          return false;
        }
        const sent = await send();
        await db.query(
          "update outbound_messages set status = 'sent', sent_at = now(), last_error = null, metadata = metadata || $3::jsonb, updated_at = now() where id = $1 and client_id = $2",
          [outbound.id, outbound.client_id, JSON.stringify(sent?.providerMessageId ? { providerMessageId: sent.providerMessageId } : {})],
        );
        return true;
      });
      if (!allowed) return { status: "skipped", outboundMessageId: outbound.id,
        reason: "Human-owned conversation; AI reply suppressed." };
    } else {
      const sent = await send();
      await query(
        "update outbound_messages set status = 'sent', sent_at = now(), last_error = null, metadata = metadata || $3::jsonb, updated_at = now() where id = $1 and client_id = $2",
        [outbound.id, outbound.client_id, JSON.stringify(sent?.providerMessageId ? { providerMessageId: sent.providerMessageId } : {})],
      );
    }
    logInfo("outbox.flush_sent", {
      requestId: options.requestId,
      outboundMessageId: outbound.id,
      clientId: outbound.client_id,
      conversationId: outbound.conversation_id,
      escalationId: outbound.escalation_id,
      channelId: outbound.channel_id,
      attemptCount: outbound.attempt_count,
    });
    return { status: "sent", outboundMessageId: outbound.id };
  } catch (error) {
    const message = errorToMessage(error);
    const status = sendAccepted || error instanceof AmbiguousProviderAcceptanceError ||
      (error instanceof ProviderSendError && error.ambiguous) ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
      ? "uncertain"
      : error instanceof ChannelPolicyError || (error instanceof ProviderSendError && !error.retryable) ||
          outbound.attempt_count >= maxAttempts
        ? "dead" : "failed";
    await query(
      `
        update outbound_messages
        set status = $4,
            last_error = $2,
            updated_at = now()
        where id = $1 and client_id = $3
      `,
      [outbound.id, message, outbound.client_id, status],
    );
    logWarn("outbox.flush_failed", {
      requestId: options.requestId,
      outboundMessageId: outbound.id,
      clientId: outbound.client_id,
      conversationId: outbound.conversation_id,
      escalationId: outbound.escalation_id,
      channelId: outbound.channel_id,
      attemptCount: outbound.attempt_count,
      error,
    });
    await recordErrorEvent({
      eventName: "outbox.flush_failed",
      source: "outbound",
      severity: status === "dead" || status === "uncertain" ? "error" : "warning",
      requestId: options.requestId ?? null,
      clientId: outbound.client_id,
      channelId: outbound.channel_id,
      message,
      metadata: {
        outboundMessageId: outbound.id,
        conversationId: outbound.conversation_id,
        escalationId: outbound.escalation_id,
        attemptCount: outbound.attempt_count,
      },
    });
    return { status: "failed", outboundMessageId: outbound.id, error: message };
  }
}

export async function listRetryableOutboundMessages(
  input: OutboundRetryBatchInput = {},
): Promise<OutboundMessage[]> {
  const limit = normalizePositiveInteger(input.limit, DEFAULT_RETRY_LIMIT);
  const maxAttempts = normalizePositiveInteger(
    input.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
  );

  const result = await query<OutboundMessage>(
    `
      select *
      from outbound_messages
      where attempt_count < $1
        and status in ('pending', 'failed')
      order by updated_at asc
      limit $2
    `,
    [maxAttempts, limit],
  );

  return result.rows;
}

export async function markStaleOutboundUncertain(staleMinutes = DEFAULT_STALE_SENDING_MINUTES): Promise<number> {
  const result = await query(
    `update outbound_messages set status = 'uncertain', last_error = 'Worker stopped during provider send; reconcile before retry.',
       updated_at = now() where status = 'sending' and updated_at <= now() - make_interval(mins => $1::int)`,
    [normalizePositiveInteger(staleMinutes, DEFAULT_STALE_SENDING_MINUTES)],
  );
  return result.rowCount ?? 0;
}

export async function flushRetryableOutboundMessages(
  input: OutboundRetryBatchInput = {},
): Promise<OutboundRetryBatchResult> {
  const messages = await listRetryableOutboundMessages(input);
  const results: OutboundFlushResult[] = [];

  logInfo("outbox.retry_batch_started", {
    requestId: input.requestId,
    retryableCount: messages.length,
    limit: input.limit ?? DEFAULT_RETRY_LIMIT,
  });

  for (const message of messages) {
    results.push(await flushOutboundMessage(message.id, input));
  }

  const summary = results.reduce(
    (accumulator, result) => ({
      attempted: accumulator.attempted + 1,
      sent: accumulator.sent + (result.status === "sent" ? 1 : 0),
      failed: accumulator.failed + (result.status === "failed" ? 1 : 0),
      skipped: accumulator.skipped + (result.status === "skipped" ? 1 : 0),
    }),
    { attempted: 0, sent: 0, failed: 0, skipped: 0 },
  );

  logInfo("outbox.retry_batch_completed", {
    requestId: input.requestId,
    ...summary,
  });

  return {
    ...summary,
    results,
  };
}

function errorToMessage(error: unknown): string {
  return redactErrorMessage(error);
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return fallback;
  }
  return value;
}
