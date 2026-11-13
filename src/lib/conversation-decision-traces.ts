import { query } from "@/lib/db";
import { buildConversationDecision, type DecisionRecord } from "@/lib/conversation-decision-flow";

export async function getConversationDecisionTraces(clientId: string, conversationId: string) {
  const result = await query<DecisionRecord>(`
    select m.id as message_id, m.body, m.created_at, coalesce(m.metadata->>'aiPausedAtIngestion'='true',false) as ai_paused,
      t.id as trace_id, t.status, t.reason_code, e.reason_detail, coalesce(t.retrieval_chunk_count,0) as retrieval_chunk_count,
      t.cited_chunk_ids, t.steps,
      sources.items as sources, coalesce(usage.provider,t.response_provider) as model_provider, coalesce(usage.model,t.response_model) as model_name,
      reply.metadata->>'responseProvider' as intake_provider, reply.metadata->>'responseModel' as intake_model,
      exists(select 1 from agent_usage_events usage where usage.client_id=m.client_id and usage.conversation_id=m.conversation_id
        and usage.operation='generation' and usage.metadata->>'customerMessageId'=m.id::text
        and coalesce(usage.metadata->>'purpose','')<>'handoff_intake') as model_ran,
      reply.body as reply_body, coalesce(reply.metadata->>'handoffIntake'='true',false) as handoff_intake,
      delivery.status as delivery_status, job.status as job_status, job.failure_code as job_failure_code
    from messages m
    join conversations c on c.id=m.conversation_id and c.client_id=m.client_id and c.deleted_at is null
    left join lateral (select * from agent_traces trace where trace.client_id=m.client_id
      and trace.conversation_id=m.conversation_id and trace.customer_message_id=m.id order by trace.created_at desc limit 1) t on true
    left join escalations e on e.id=t.escalation_id and e.client_id=m.client_id
    left join lateral (select u.provider,u.model from agent_usage_events u where u.client_id=m.client_id
      and u.conversation_id=m.conversation_id and u.operation='generation' and u.metadata->>'customerMessageId'=m.id::text
      and coalesce(u.metadata->>'purpose','')<>'handoff_intake' order by u.created_at desc limit 1) usage on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('chunkId',score->>'id','sourceId',s.id,
        'title',coalesce(s.title,'Source no longer available'),
        'url',coalesce(s.metadata->>'sourceUrl',s.metadata->>'sourceReference'),
        'excerpt',left(k.content,500),'version',null,'snapshot',false)) as items
      from jsonb_array_elements(coalesce(t.retrieval_chunk_scores,'[]'::jsonb)) score
      left join knowledge_chunks k on k.id::text=score->>'id' and k.client_id=m.client_id
      left join knowledge_sources s on s.id=k.source_id and s.client_id=m.client_id
    ) sources on true
    left join lateral (select a.body,a.metadata,a.id from messages a where a.client_id=m.client_id and a.conversation_id=m.conversation_id
      and a.sender_role='agent' and a.metadata->>'customerMessageId'=m.id::text order by a.created_at desc limit 1) reply on true
    left join lateral (select o.status from outbound_messages o where o.client_id=m.client_id and o.conversation_id=m.conversation_id
      and o.metadata->>'agentMessageId'=reply.id::text order by o.created_at desc limit 1) delivery on true
    left join lateral (select j.status,j.failure_code from inbound_jobs j where j.client_id=m.client_id and j.conversation_id=m.conversation_id
      and j.message_id=m.id order by j.created_at desc limit 1) job on true
    where m.client_id=$1 and m.conversation_id=$2 and m.sender_role='customer'
    order by m.created_at desc limit 50`, [clientId, conversationId]);
  return result.rows.reverse().map(buildConversationDecision);
}
