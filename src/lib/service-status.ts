import {getPool} from '@/lib/db';
import {protectedDemoDeployment} from '@/lib/deployment-profile';
import {assertCustomerDemoEnabled,DEMO_CLIENT_ID,DEMO_CHANNEL_ID} from '@/lib/customer-demo-boundary';
import {requireRealDemoConfiguration,profileForDemoChoice} from '@/lib/customer-demo-ai';
import {DEFAULT_DEMO_MODEL} from '@/lib/llm/demo-models';
import {replyFailure} from '@/lib/reply-failure';

export type StatusCheck={id:string;name:string;state:'ok'|'warning'|'error'|'unknown';detail:string;observedAt?:string|null;code?:string};
export type ServiceStatus={status:'operational'|'degraded'|'unavailable';checkedAt:string;revision:string|null;checks:StatusCheck[];providerProbe:false};
type Telemetry={pending:number;processing:number;stopped:number;last_success:Date|string|null;last_failure:Date|string|null;failure_code:string|null;cooldown_code:string|null;retry_after:Date|string|null;stopped_code?:string|null;stopped_at?:Date|string|null};
const iso=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null;

// Public output contains service-level observations only, never messages,
// identities, tenant IDs, credentials or raw provider errors. No inference.
export async function getServiceStatus():Promise<ServiceStatus>{
 const checkedAt=new Date().toISOString();
 const revision=/^[a-f0-9]{40}$/i.test(process.env.RENDER_GIT_COMMIT??'')?process.env.RENDER_GIT_COMMIT!:null;
 const checks:StatusCheck[]=[{id:'app',name:'Application',state:'ok',detail:'The web service is responding.'}];
 try{await getPool().query('select 1');checks.push({id:'database',name:'Database',state:'ok',detail:'The database is reachable.'});}
 catch{checks.push({id:'database',name:'Database',state:'error',detail:'The database cannot currently be reached.'});
  return {status:'unavailable',checkedAt,revision,checks,providerProbe:false};}
 if(protectedDemoDeployment()||process.env.PRONTO_CUSTOMER_DEMO_ENABLED==='1'){
  let provider:string|null=null;
  try{await assertCustomerDemoEnabled();const config=await requireRealDemoConfiguration(true,profileForDemoChoice(DEFAULT_DEMO_MODEL));provider=config.provider;
   checks.push({id:'configuration',name:'AI setup & knowledge',state:'ok',detail:'The configured model and approved knowledge are present. Credentials have not been tested against the provider.'});}
  catch{checks.push({id:'configuration',name:'AI setup & knowledge',state:'error',detail:'The demo configuration or approved knowledge needs attention.'});}
  try{
   const result=await getPool().query<Telemetry>(`select
    (select count(*)::int from inbound_jobs where client_id=$1 and channel_id=$2 and status in ('pending','failed')) pending,
    (select count(*)::int from inbound_jobs where client_id=$1 and channel_id=$2 and status='processing') processing,
    ((select count(*) from inbound_jobs where client_id=$1 and channel_id=$2 and status='dead')+
     (select count(*) from outbound_messages where client_id=$1 and channel_id=$2 and status in ('dead','uncertain')))::int stopped,
    (select failure_code from inbound_jobs where client_id=$1 and channel_id=$2 and status='dead' order by updated_at desc limit 1) stopped_code,
    (select max(updated_at) from inbound_jobs where client_id=$1 and channel_id=$2 and status='dead') stopped_at,
    (select max(created_at) from agent_traces where client_id=$1 and response_provider=$3 and status='answered') last_success,
    (select max(created_at) from agent_traces where client_id=$1 and response_provider=$3 and status='failed') last_failure,
    (select reason_code from agent_traces where client_id=$1 and response_provider=$3 and status='failed' order by created_at desc limit 1) failure_code,
    (select failure_code from provider_cooldowns where client_id=$1 and provider=$3 and retry_after>now()) cooldown_code,
    (select retry_after from provider_cooldowns where client_id=$1 and provider=$3 and retry_after>now()) retry_after`,[DEMO_CLIENT_ID,DEMO_CHANNEL_ID,provider]);
   const t=result.rows[0];if(!t)throw Error('Status observation unavailable');
   const recentFailure=t.cooldown_code||t.last_failure&&(!t.last_success||new Date(t.last_failure)>new Date(t.last_success));
   if(recentFailure){const failure=replyFailure(t.cooldown_code??t.failure_code);
    checks.push({id:'provider',name:'AI replies',state:'warning',detail:failure.detail+(t.retry_after?` Recovery delay until ${iso(t.retry_after)}.`:''),code:failure.code,observedAt:iso(t.last_failure)});}
   else checks.push({id:'provider',name:'AI replies',state:t.last_success?'ok':'unknown',detail:t.last_success?'Last recorded AI reply succeeded. This is a saved observation, not a live provider test.':'No successful AI reply has been recorded yet.',observedAt:iso(t.last_success)});
   checks.push({id:'queue',name:'Reply processing',state:t.stopped?'warning':t.pending||t.processing?'unknown':'ok',
    ...(t.stopped?{code:replyFailure(t.stopped_code).code,observedAt:iso(t.stopped_at)}:{}),
    detail:t.stopped?`${t.stopped} saved request(s) or deliveries need a retry. New conversations may still work. Retry stopped messages from their customer chat.`:
     `${t.pending} waiting, ${t.processing} processing. Work runs while an authenticated demo page is open.`});
  }catch{checks.push({id:'queue',name:'Reply processing',state:'error',detail:'Processing observations could not be loaded.'});}
 }else checks.push({id:'provider',name:'AI replies',state:'unknown',detail:'Detailed AI observations are available on the enabled synthetic demo only.'});
 return {status:checks.some(c=>c.state==='error'||c.state==='warning')?'degraded':'operational',checkedAt,revision,checks,providerProbe:false};
}
