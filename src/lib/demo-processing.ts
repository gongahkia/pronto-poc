import {query} from '@/lib/db';
import type {SessionUser} from '@/lib/auth';
import {enterTenantContext} from '@/lib/tenant-context';
import {assertDemoActor} from '@/lib/customer-demo';
import {DEMO_CLIENT_ID,DEMO_CHANNEL_ID,DemoError} from '@/lib/customer-demo-boundary';
import {requestDrivenDemoProcessing,protectedDemoConfiguration} from '@/lib/deployment-profile';
import {processInboundJob} from '@/lib/channels/inbox-worker';
import {flushOutboundMessage} from '@/lib/channels/outbox';
import {logWarn} from '@/lib/logger';
import {demoInstagramConfiguration,assertDemoInstagramScope} from '@/lib/channels/instagram-demo';
import {getInstagramChannel} from '@/lib/channels/instagram';

let running:Promise<DemoProcessingResult>|null=null;
export type DemoProcessingResult={busy:boolean;processed:number;delivered:number;failed:boolean};

// One bounded, awaited slice per authenticated request. No server timer or
// fire-and-forget work: PostgreSQL jobs/leases survive a process disappearing.
export async function processDemoQueue(actor:SessionUser):Promise<DemoProcessingResult>{
 if(!requestDrivenDemoProcessing())throw new DemoError('Request processing is not enabled.',404);
 protectedDemoConfiguration();enterTenantContext(actor);await assertDemoActor(actor);
 if(running)return {busy:true,processed:0,delivered:0,failed:false};
 const scope=demoInstagramConfiguration();
 return startDrain([DEMO_CHANNEL_ID,...(scope?[scope.channelId]:[])]);
}

// Called only after signature/account/sender checks and durable ingestion. UI
// requests use the same coordinator to resume work after a restart or cooldown.
export async function processDemoInstagramQueue(channelId:string):Promise<DemoProcessingResult>{
 if(!requestDrivenDemoProcessing())throw new DemoError('Request processing is not enabled.',404);
 const scope=demoInstagramConfiguration();
 if(!scope||scope.channelId!==channelId)throw new DemoError('Unknown demo Instagram channel.',403);
 const channel=await getInstagramChannel(channelId,DEMO_CLIENT_ID);
 if(!channel)throw new DemoError('Demo Instagram channel is unavailable.',503);
 await assertDemoInstagramScope(channel);
 const total:DemoProcessingResult={busy:false,processed:0,delivered:0,failed:false};
 const deadline=Date.now()+90000;
 // A bounded slice, not a persistent inference loop. More saved work resumes on
 // the next webhook or ordinary inbox processing request.
 for(let round=0;round<3;round++){
  if(Date.now()>=deadline){total.busy=true;break;}
  if(running){let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([running.catch(()=>{}),new Promise<void>(done=>{timer=setTimeout(done,15000);})]);}
   finally{clearTimeout(timer);}}
  if(running){total.busy=true;break;}
  const part=await startDrain([channelId]);total.processed+=part.processed;total.delivered+=part.delivered;total.failed ||=part.failed;
  if(!part.processed&&!part.delivered)break;
 }
 return total;
}

async function startDrain(channelIds:string[]):Promise<DemoProcessingResult>{
 const task=drain(channelIds);running=task;
 try{return await task;}finally{if(running===task)running=null;}
}

async function drain(channelIds:string[]):Promise<DemoProcessingResult>{
 const result:DemoProcessingResult={busy:false,processed:0,delivered:0,failed:false};
 await query(`insert into demo_processing_status(client_id,last_started_at) values($1,now())
  on conflict(client_id) do update set last_started_at=now()`,[DEMO_CLIENT_ID]);
 try{
  // Exhausted inbound leases cannot block the conversation forever invisibly.
  for(const channelId of channelIds)await query(`update inbound_jobs set status='dead',lease_expires_at=null,updated_at=now(),
   last_error='Demo processing stopped after the final attempt.' where client_id=$1 and channel_id=$2
   and status='processing' and attempt_count>=5 and lease_expires_at<=now()`,[DEMO_CLIENT_ID,channelId]);
  // Only this exact console channel has no external send side effect. Never
  // apply automatic uncertain-send recovery to Instagram/email/other providers.
  await query(`update outbound_messages o set status=case when attempt_count>=5 then 'dead' else 'pending' end,
   last_error='Synthetic delivery interrupted; recovered after lease expiry.',updated_at=now()
   where o.client_id=$1 and o.channel_id=$2 and o.status='sending' and o.updated_at<now()-interval '2 minutes'
   and exists(select 1 from channels ch where ch.client_id=$1 and ch.id=$2 and ch.kind='console'
    and ch.status='active' and ch.settings->>'transport'='customer_simulator')`,[DEMO_CLIENT_ID,DEMO_CHANNEL_ID]);
  // Deliver saved replies before starting another model call, including human replies.
  for(const channelId of channelIds){
   result.delivered+=await deliver(channelId);
   try{const job=await processInboundJob({clientId:DEMO_CLIENT_ID,channelId,requestId:'demo-request'});result.processed+=job?1:0;}
   catch(error){result.failed=true;logWarn('demo.request_processing_failed',{clientId:DEMO_CLIENT_ID,error});}
   result.delivered+=await deliver(channelId);
  }
  await query(`update demo_processing_status set last_completed_at=now(),last_failed_at=case when $2 then now() else last_failed_at end where client_id=$1`,[DEMO_CLIENT_ID,result.failed]);
  return result;
 }catch(error){
  await query('update demo_processing_status set last_failed_at=now() where client_id=$1',[DEMO_CLIENT_ID]).catch(()=>{});
  throw error;
 }
}
async function deliver(channelId:string){
 const rows=await query<{id:string}>(`select id from outbound_messages where client_id=$1 and channel_id=$2 and attempt_count<5
  and (status='pending' or (status='failed' and updated_at<=now()-interval '10 seconds')) order by created_at,id limit 3`,[DEMO_CLIENT_ID,channelId]);
 let delivered=0;
 for(const row of rows.rows){const sent=await flushOutboundMessage(row.id,{clientId:DEMO_CLIENT_ID,maxAttempts:5,requestId:'demo-request'});if(sent.status==='sent')delivered++;}
 return delivered;
}
