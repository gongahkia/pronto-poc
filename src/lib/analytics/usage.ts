import { query } from '@/lib/db';
import type { UsageSummary } from './types';
export function usageMonth(value?: string, now = new Date()) {
  const month = value ?? now.toISOString().slice(0,7);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a valid billing month.');
  const from = new Date(`${month}-01T00:00:00Z`);
  const until = new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,1));
  return { month, from: from.toISOString(), until: until.toISOString() };
}
export const deliveredReplySql = `m.sender_role='agent' and m.metadata->>'generationMode'='real'
  and coalesce(m.metadata->>'responseProvider','')<>'mock'
  and exists(select 1 from outbound_messages o where o.client_id=m.client_id and o.conversation_id=m.conversation_id
    and o.metadata->>'agentMessageId'=m.id::text and o.status='sent' and o.sent_at >= $2 and o.sent_at < $3)`;
export type MeteredEvent = { id: string; provider: string; model: string; operation: string; input_tokens: number; output_tokens: number;
  metadata: Record<string,unknown>; created_at: Date };
export async function getUsageEvents(clientId: string, from: string, until: string) {
  // Provider response identity prevents a replayed ledger row from charging twice.
  return (await query<MeteredEvent>(`select * from (select distinct on
    (coalesce(provider||':'||model||':'||operation||':'||nullif(metadata->>'providerResponseId',''),id::text)) *
    from agent_usage_events where client_id=$1 and provider<>'mock' and created_at >= $2 and created_at < $3
    order by coalesce(provider||':'||model||':'||operation||':'||nullif(metadata->>'providerResponseId',''),id::text),created_at,id
    ) recorded order by created_at desc,id desc`,[clientId,from,until])).rows;
}
export function summarizeUsage(events: MeteredEvent[], period: ReturnType<typeof usageMonth>, deliveredReplies: number): UsageSummary {
  const summary: UsageSummary = { ...period, deliveredReplies, generationCalls:0,internalCalls:0,embeddingCalls:0,
    providerInputTokens:0,providerOutputTokens:0,estimatedInputTokens:0,estimatedOutputTokens:0,
    reasoningTokens:0,reasoningReportedCalls:0,providerReportedCalls:0,estimatedCalls:0,breakdown:[],models:[] };
  const purposes = new Map<string,UsageSummary['breakdown'][number]>(); const models = new Map<string,UsageSummary['models'][number]>();
  for (const event of events) {
    const purpose = event.operation==='embedding' ? 'Knowledge retrieval' : event.metadata.purpose==='reservation_query' ? 'Reservation planning'
      : typeof event.metadata.purpose==='string' && event.metadata.purpose.startsWith('selfserve_') ? 'Business setup'
      : event.metadata.purpose==='handoff_intake' ? 'Handoff intake' : event.metadata.purpose==='analytics_synthesis' ? 'Analytics synthesis' : 'Reply decisions';
    if(event.operation==='generation') summary.generationCalls++; else if(event.operation==='embedding') summary.embeddingCalls++;
    if(event.operation==='generation' && purpose!=='Reply decisions') summary.internalCalls++;
    const measured = event.metadata.usageSource==='provider';
    if(measured){summary.providerReportedCalls++;summary.providerInputTokens+=Number(event.input_tokens);summary.providerOutputTokens+=Number(event.output_tokens);}
    else {summary.estimatedCalls++;summary.estimatedInputTokens+=Number(event.input_tokens);summary.estimatedOutputTokens+=Number(event.output_tokens);}
    const reasoning=event.metadata.reasoningTokens;
    if(measured && typeof reasoning==='number' && Number.isFinite(reasoning) && reasoning>=0){summary.reasoningReportedCalls++;summary.reasoningTokens+=reasoning;}
    const row=purposes.get(purpose)??{purpose,calls:0,inputTokens:0,outputTokens:0,estimatedCalls:0};
    row.calls++;row.inputTokens+=Number(event.input_tokens);row.outputTokens+=Number(event.output_tokens);if(!measured)row.estimatedCalls++;purposes.set(purpose,row);
    const key=`${event.provider}/${event.model}`; const model=models.get(key)??{provider:event.provider,model:event.model,calls:0};model.calls++;models.set(key,model);
  }
  summary.breakdown=[...purposes.values()].sort((a,b)=>b.calls-a.calls);summary.models=[...models.values()].sort((a,b)=>b.calls-a.calls);return summary;
}
export async function getWorkspaceUsage(clientId: string, month?: string) {
  const period=usageMonth(month);
  const [events,replies]=await Promise.all([getUsageEvents(clientId,period.from,period.until),
    query<{count:number}>(`select count(*)::int count from messages m where m.client_id=$1 and ${deliveredReplySql}`,[clientId,period.from,period.until])]);
  return summarizeUsage(events,period,replies.rows[0].count);
}
export function usageCsv(events: MeteredEvent[]) {
  const cell=(value:unknown)=>{let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s=`'${s}`;return `"${s.replace(/"/g,'""')}"`;};
  const rows=[['event_id','timestamp_utc','provider','model','operation','purpose','input_tokens','output_tokens','reasoning_tokens_included_in_output','usage_source','provider_response_id'],
    ...events.map(e=>[e.id,e.created_at.toISOString(),e.provider,e.model,e.operation,e.metadata.purpose??'reply_decision',e.input_tokens,e.output_tokens,e.metadata.reasoningTokens??'',e.metadata.usageSource??'estimate',e.metadata.providerResponseId??''])];
  return rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
