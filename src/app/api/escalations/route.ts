import { publicAppUrl } from "@/lib/http/redirect";
import { assertSameOrigin } from "@/lib/http/csrf";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth-navigation";
import { hasStaffCapability } from "@/lib/staff-permissions";
import { recordAuditLog } from "@/lib/audit";
import {
  enqueueOutboundMessage,
  flushOutboundMessage,
} from "@/lib/channels/outbox";
import { query, transaction } from "@/lib/db";
import { canAccessClient } from "@/lib/rbac";
import {
  bulkAssignEscalations,
  bulkClaimEscalations,
  bulkResolveEscalations,
} from "@/lib/escalations-bulk";
import type { ChannelKind, EscalationStatus } from "@/lib/types";

type EscalationActionRecord = {
  id: string;
  client_id: string;
  conversation_id: string;
  status: EscalationStatus;
  channel_id: string;
  channel_kind: ChannelKind;
  external_thread_id: string;
};

type OwnerReplyOutboundRecord = {
  id: string;
  client_id: string;
  escalation_id: string | null;
  status: "pending" | "sending" | "sent" | "failed";
};

export async function POST(request: Request) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const user = await requireUser();
  const form = await request.formData();
  const escalationId = String(form.get("escalationId") ?? "");
  const action = String(form.get("action") ?? "");
  const returnTo = safeReturnTo(form.get("returnTo")) ?? "/client/inbox";
  const actionResponse = () => user.role === "operator" ? NextResponse.json({ ok: true })
    : NextResponse.redirect(publicAppUrl(returnTo, request.url), 303);
  if (user.role === "client" && !user.clientId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (user.role === "client" && user.clientId &&
      !await hasStaffCapability(user, user.clientId,
        action === "release" ? "conversation.release" : "conversation.respond")) {
    return NextResponse.json({ error: "This staff action has not been authorized." }, { status: 403 });
  }

  if (action === "bulk_claim" || action === "bulk_resolve" || action === "bulk_assign") {
    const clientId = String(form.get("clientId") ?? "");
    if (!canAccessClient(user, clientId)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const ids = form.getAll("escalationIds").map((value) => String(value));
    let result;
    if (action === "bulk_claim") {
      result = await bulkClaimEscalations({
        escalationIds: ids,
        clientId,
        actorUserId: user.userId,
      });
    } else if (action === "bulk_assign") {
      result = await bulkAssignEscalations({
        escalationIds: ids,
        clientId,
        assigneeUserId: String(form.get("assigneeUserId") ?? ""),
        actorUserId: user.userId,
      });
    } else {
      result = await bulkResolveEscalations({
        escalationIds: ids,
        clientId,
        actorUserId: user.userId,
        resolutionNote: String(form.get("resolutionNote") ?? "").trim() || undefined,
      });
    }
    return NextResponse.json(result);
  }

  const escalation = await loadEscalation(
    escalationId,
    user.role === "client" ? user.clientId ?? undefined : undefined,
  );
  if (!escalation) {
    return NextResponse.json({ error: "Escalation not found." }, { status: 404 });
  }
  if (!canAccessClient(user, escalation.client_id)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (action === "retry_outbound") {
    const outboundMessageId = String(form.get("outboundMessageId") ?? "");
    const outbound = await loadOwnerReplyOutbound(
      outboundMessageId,
      escalation.id,
      escalation.client_id,
    );
    if (!outbound) {
      return NextResponse.json({ error: "Outbound reply not found." }, { status: 404 });
    }

    const flushResult = await flushOutboundMessage(outbound.id, {
      clientId: escalation.client_id,
    });
    await recordAuditLog({
      clientId: escalation.client_id,
      actorUserId: user.userId,
      action: "escalation.outbound_retry",
      targetType: "outbound_message",
      targetId: outbound.id,
      metadata: {
        escalationId: escalation.id,
        previousStatus: outbound.status,
        result: flushResult.status,
      },
    });

    return actionResponse();
  }

  if (action === "claim") {
    await transaction(async (client) => {
      await client.query("update conversations set status='escalated', ai_should_respond=false, owner_action_required=true where id=$1 and client_id=$2", [escalation.conversation_id, escalation.client_id]);
      await client.query(
        "update escalations set status = 'claimed', assigned_to_user_id = $3 where id = $1 and client_id = $2 and status = 'open'",
        [escalation.id, escalation.client_id, user.userId],
      );
      await recordAuditLog(
        {
          clientId: escalation.client_id,
          actorUserId: user.userId,
          action: "escalation.claimed",
          targetType: "escalation",
          targetId: escalation.id,
          metadata: { previousStatus: escalation.status },
        },
        client,
      );
    }, { isolationLevel: "serializable", retries: 2 });

    return actionResponse();
  }

  if (action === "release") {
    if (escalation.status !== "resolved") {
      return NextResponse.json({ error: "Resolve the handoff before releasing AI ownership." }, { status: 409 });
    }
    await transaction(async (db) => {
      const conversation = await db.query<{ id: string }>(
        "select id from conversations where id = $1 and client_id = $2 for update",
        [escalation.conversation_id, escalation.client_id],
      );
      if (!conversation.rows[0]) throw new Error("Conversation not found.");
      const open = await db.query<{ id: string }>(
        "select id from escalations where conversation_id = $1 and client_id = $2 and status in ('open', 'claimed') limit 1",
        [escalation.conversation_id, escalation.client_id],
      );
      if (open.rows[0]) throw new Error("Another human handoff is still open.");
      await db.query(
        "update conversations set status = 'active', ai_should_respond=true, owner_action_required=false, last_message_at = now() where id = $1 and client_id = $2",
        [escalation.conversation_id, escalation.client_id],
      );
      await recordAuditLog({
        clientId: escalation.client_id, actorUserId: user.userId,
        action: "conversation.ai_released", targetType: "conversation",
        targetId: escalation.conversation_id, metadata: { escalationId: escalation.id },
      }, db);
    }, { isolationLevel: "serializable", retries: 2 });
    return actionResponse();
  }

  if (action === "resolve") {
    const reply = String(form.get("reply") ?? "").trim();
    let outboundMessageId: string | null = null;

    await transaction(async (client) => {
      const resolved = await client.query(
        `
          update escalations
          set status = 'resolved',
              resolved_at = coalesce(resolved_at, now())
          where id = $1 and client_id = $2 and status <> 'resolved'
          returning id
        `,
        [escalation.id, escalation.client_id],
      );
      if (!resolved.rowCount) {
        return;
      }

      if (reply) {
        await client.query(
          `
            insert into messages (conversation_id, client_id, channel_id, external_message_id, sender_role, body, metadata)
            values ($1, $2, $3, $4, 'operator', $5, $6)
            on conflict (channel_id, external_message_id) do nothing
          `,
          [
            escalation.conversation_id,
            escalation.client_id,
            escalation.channel_id,
            `owner-resolution-${escalation.id}`,
            reply,
            {
              escalationId: escalation.id,
              resolvedBy: user.userId,
              sentToCustomer: true,
            },
          ],
        );
      }

      if (reply) {
        const outbound = await enqueueOutboundMessage(client, {
          clientId: escalation.client_id,
          conversationId: escalation.conversation_id,
          escalationId: escalation.id,
          channelId: escalation.channel_id,
          externalThreadId: escalation.external_thread_id,
          body: reply,
          idempotencyKey: `escalation-resolution:${escalation.id}`,
          metadata: {
            purpose: "escalation_resolution_reply",
            resolvedBy: user.userId,
          },
        });
        outboundMessageId = outbound.id;
      }

      await client.query(
        "update conversations c set status=case when exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status in ('open','claimed')) then 'escalated'::conversation_status else 'closed'::conversation_status end, ai_should_respond=false, owner_action_required=exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status in ('open','claimed')), last_message_at=now() where c.id=$1 and c.client_id=$2",
        [escalation.conversation_id, escalation.client_id],
      );
      await client.query(
        "insert into metric_events (client_id, event_type, value, metadata) values ($1, 'escalation_resolved', 1, $2)",
        [
          escalation.client_id,
          { escalationId: escalation.id, resolvedBy: user.userId, sentReply: Boolean(reply) },
        ],
      );
      await recordAuditLog(
        {
          clientId: escalation.client_id,
          actorUserId: user.userId,
          action: "escalation.resolved",
          targetType: "escalation",
          targetId: escalation.id,
          metadata: {
            previousStatus: escalation.status,
            sentReply: Boolean(reply),
            outboundQueued: Boolean(outboundMessageId),
          },
        },
        client,
      );
    }, { isolationLevel: "serializable", retries: 2 });

    if (outboundMessageId) {
      await flushOutboundMessage(outboundMessageId, {
        clientId: escalation.client_id,
      });
    }

    return actionResponse();
  }

  return NextResponse.json({ error: "Unsupported escalation action." }, { status: 400 });
}

async function loadEscalation(
  escalationId: string,
  clientId?: string,
): Promise<EscalationActionRecord | null> {
  const result = await query<EscalationActionRecord>(
    `
      select
        e.id,
        e.client_id,
        e.conversation_id,
        e.status,
        c.channel_id,
        c.external_thread_id,
        ch.kind as channel_kind
      from escalations e
      join conversations c on c.id = e.conversation_id
      join channels ch on ch.id = c.channel_id
      where e.id = $1
        ${clientId ? "and e.client_id = $2" : ""}
    `,
    clientId ? [escalationId, clientId] : [escalationId],
  );
  return result.rows[0] ?? null;
}

async function loadOwnerReplyOutbound(
  outboundMessageId: string,
  escalationId: string,
  clientId: string,
): Promise<OwnerReplyOutboundRecord | null> {
  const result = await query<OwnerReplyOutboundRecord>(
    `
      select id, client_id, escalation_id, status
      from outbound_messages
      where id = $1
        and escalation_id = $2
        and client_id = $3
        and metadata->>'purpose' = 'escalation_resolution_reply'
    `,
    [outboundMessageId, escalationId, clientId],
  );
  return result.rows[0] ?? null;
}
