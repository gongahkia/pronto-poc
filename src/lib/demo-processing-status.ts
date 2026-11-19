import {query} from '@/lib/db';
import {DEMO_CLIENT_ID,DEMO_CHANNEL_ID} from '@/lib/customer-demo-boundary';
import {demoInstagramConfiguration} from '@/lib/channels/instagram-demo';
export async function getDemoProcessingStatus(){
 const scope=demoInstagramConfiguration();const channels=scope?[DEMO_CHANNEL_ID,scope.channelId]:null;
 const channelMatch=channels?'=any($2::uuid[])':'=$2';
 const result=await query<{pending:number;processing:number;stopped:number;last_started_at:Date|null;last_completed_at:Date|null;last_failed_at:Date|null}>(`select
  (select count(*)::int from inbound_jobs where client_id=$1 and channel_id${channelMatch} and status in ('pending','failed')) pending,
  (select count(*)::int from inbound_jobs where client_id=$1 and channel_id${channelMatch} and status='processing') processing,
  ((select count(*) from inbound_jobs where client_id=$1 and channel_id${channelMatch} and status='dead')+
   (select count(*) from outbound_messages where client_id=$1 and channel_id${channelMatch} and status in ('dead','uncertain')))::int stopped,
  s.last_started_at,s.last_completed_at,s.last_failed_at from (select 1) present
  left join demo_processing_status s on s.client_id=$1`,[DEMO_CLIENT_ID,channels??DEMO_CHANNEL_ID]);
 return {mode:'request' as const,continuousWorker:false,...result.rows[0]};
}
