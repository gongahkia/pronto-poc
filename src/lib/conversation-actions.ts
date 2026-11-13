import type { SessionUser } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { recordAuditLog } from "@/lib/audit";
import { requireStaffCapability } from "@/lib/staff-permissions";
import { DemoError } from "@/lib/customer-demo-boundary";
import type { Conversation } from "@/lib/types";

export async function recordConversationOutcome(clientId: string, conversationId: string,
  outcome: "answered" | "escalated" | "skipped"): Promise<void> {
  await query(`update conversations c set
    ai_should_respond=(c.status='active' and ($3='answered' or exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status='open' and e.allow_ai_followups))),
    owner_action_required=case when c.status='escalated' then true when c.status='closed' then false else c.owner_action_required end,
    urgency=coalesce(c.urgency, case when exists(select 1 from escalations e
      where e.client_id=$1 and e.conversation_id=c.id and e.reason_code='urgent_or_negative_sentiment')
      then 'short_term' else 'long_term' end)
    where c.id=$2 and c.client_id=$1`, [clientId, conversationId, outcome]);
}

export async function updateConversationAction(input: { actor: SessionUser; clientId: string;
  conversationId: string; action: "takeover" | "classify"; ownerActionRequired?: boolean;
  urgency?: "short_term" | "long_term" }): Promise<void> {
  await transaction(async db => {
    await requireStaffCapability(input.actor, input.clientId, "conversation.respond", db);
    const result = await db.query<Conversation>("select * from conversations where id=$1 and client_id=$2 and deleted_at is null for update",
      [input.conversationId, input.clientId]);
    const conversation = result.rows[0];
    if (!conversation) throw new DemoError("Conversation not found.", 404);
    if (input.action === "classify") {
      const pending = await db.query("select id from escalations where client_id=$1 and conversation_id=$2 and status in ('open','claimed') limit 1", [input.clientId, conversation.id]);
      if ((conversation.status === "escalated" || pending.rows.length > 0) && !input.ownerActionRequired)
        throw new DemoError("Resolve the human handoff before clearing owner action.", 409);
      if (conversation.status === "closed" && input.ownerActionRequired)
        throw new DemoError("This conversation is resolved.", 409);
      await db.query("update conversations set owner_action_required=$3, urgency=$4 where id=$1 and client_id=$2",
        [conversation.id, input.clientId, input.ownerActionRequired, input.urgency]);
    } else {
      if (conversation.status === "closed") throw new DemoError("This conversation is resolved.", 409);
      const message = await db.query<{ id: string }>(`select id from messages where conversation_id=$1
        and client_id=$2 and sender_role='customer' order by created_at desc limit 1`, [conversation.id, input.clientId]);
      if (!message.rows[0]) throw new DemoError("A customer message is required before takeover.", 409);
      const open = await db.query<{ id: string }>(`select id from escalations where conversation_id=$1
        and client_id=$2 and status in ('open','claimed') limit 1`, [conversation.id, input.clientId]);
      if (open.rows[0]) await db.query(`update escalations set status='claimed', assigned_to_user_id=$3
        where id=$1 and client_id=$2`, [open.rows[0].id, input.clientId, input.actor.userId]);
      else await db.query(`insert into escalations (client_id,conversation_id,message_id,status,reason_code,reason_detail,assigned_to_user_id)
        values ($1,$2,$3,'claimed','staff_takeover','An authorized business responder took over.', $4)`,
        [input.clientId, conversation.id, message.rows[0].id, input.actor.userId]);
      await db.query(`update conversations set status='escalated', ai_should_respond=false,
        owner_action_required=true where id=$1 and client_id=$2`, [conversation.id, input.clientId]);
    }
    await recordAuditLog({ clientId: input.clientId, actorUserId: input.actor.userId,
      action: input.action === "takeover" ? "conversation.taken_over" : "conversation.classified",
      targetType: "conversation", targetId: conversation.id,
      metadata: input.action === "classify" ? { ownerActionRequired: input.ownerActionRequired, urgency: input.urgency } : {} }, db);
  }, { isolationLevel: "serializable", retries: 2 });
}
