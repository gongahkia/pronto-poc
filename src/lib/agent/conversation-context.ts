import { query, type Queryable } from "@/lib/db";
import type { Message } from "@/lib/types";

// Job sequence is authoritative even when concurrent transactions have equal or
// inverted timestamps. Earlier AI replies refer to their originating customer
// job and remain usable when the next enquiry was already queued.
// Instagram may deliver an older event after a newer enquiry. Its normalized
// provider clock bounds context too, so the late turn cannot see future facts.
export async function loadConversationContext(input: {
  clientId: string; conversationId: string; customerMessageId: string; includeCurrent?: boolean; limit?: number;
}, db: Queryable = { query }): Promise<Message[]> {
  const result = await db.query<Message>(`with anchor as (
    select m.created_at, j.sequence,
      case when m.metadata->>'channelKind' = 'instagram' then m.metadata->>'providerOccurredAt' end as provider_at
    from messages m
    left join inbound_jobs j on j.message_id = m.id and j.client_id = m.client_id
    where m.id = $3 and m.client_id = $2 and m.conversation_id = $1 and m.sender_role = 'customer'
  ) select m.* from messages m cross join anchor a
    left join inbound_jobs origin on origin.client_id = m.client_id and origin.conversation_id = m.conversation_id
      and (origin.message_id = m.id or origin.message_id::text = m.metadata->>'customerMessageId')
    left join messages origin_message on origin_message.id = origin.message_id
      and origin_message.client_id = m.client_id and origin_message.conversation_id = m.conversation_id
    where m.conversation_id = $1 and m.client_id = $2
      and (m.id = $3 and $5::boolean or m.id <> $3 and case
        when a.sequence is not null and origin.sequence is not null then origin.sequence < a.sequence
        else m.created_at < a.created_at end)
      and (a.provider_at is null or origin_message.metadata->>'channelKind' is distinct from 'instagram'
        or origin_message.metadata->>'providerOccurredAt' is null
        or origin_message.metadata->>'providerOccurredAt' <= a.provider_at)
    order by m.created_at desc, m.id desc limit $4`,
  [input.conversationId, input.clientId, input.customerMessageId, Math.max(1, Math.min(input.limit ?? 8, 20)), input.includeCurrent ?? false]);
  return result.rows;
}
