import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction} from '@/lib/db';
import {recordAuditLog} from '@/lib/audit';
import {handoverPresets,type Handovers} from './catalog';
import {lockSettings,checkRevision,touch,queueJob,SelfServeError} from './store';
export const selfServeUIEnabled=()=>process.env.PRONTO_SELF_SERVE_ENABLED==='1';
const alertSchema=z.object({whatsapp_enabled:z.boolean(),email_enabled:z.boolean(),whatsapp_number:z.string().max(30),email_address:z.string().max(254)}).strict();
export async function updateSettings(clientId:string,actorId:string,input:Record<string,unknown>){
 return transaction(async db=>{
  const current=await lockSettings(db,clientId);checkRevision(current,input.version);
  if(input.handovers){
   const handovers=z.object({presets:z.record(z.string(),z.object({enabled:z.boolean(),params:z.object({min_group_size:z.number().int().min(1).max(500)}).optional()}).strict()),custom:z.array(z.object({id:z.uuid(),text:z.string().trim().min(1).max(500)}).strict()).max(100)}).strict().parse(input.handovers) as Handovers;
   if(Object.keys(handovers.presets).length!==handoverPresets.length||handoverPresets.some(p=>!handovers.presets[p.key]||('locked' in p&&!handovers.presets[p.key].enabled)))throw new SelfServeError('Unknown and conflicting rules must always hand over.');
   if(!handovers.presets.large_group.params)throw new SelfServeError('Set the large group threshold.');
   const existing=new Set(current.handovers.custom.map(r=>r.id));if(handovers.custom.some(r=>!existing.has(r.id)))throw new SelfServeError('Use Add situation to create a custom handover.');
   await db.query('update selfserve_settings set handovers=$2 where client_id=$1',[clientId,handovers]);
  }else if(input.alerts){
   const alerts=alertSchema.parse(input.alerts);alerts.whatsapp_number=alerts.whatsapp_number.trim();alerts.email_address=alerts.email_address.trim();
   if(alerts.whatsapp_enabled&&!/^\+[1-9]\d{7,14}$/.test(alerts.whatsapp_number))throw new SelfServeError('Enter a WhatsApp number with its country code, such as +65…');
   if(alerts.email_enabled&&!z.email().safeParse(alerts.email_address).success)throw new SelfServeError('Enter a valid alert email address.');
   for(const kind of ['whatsapp','email'] as const){
    if(!alerts[kind==='whatsapp'?'whatsapp_enabled':'email_enabled'])continue;
    const destination=alerts[kind==='whatsapp'?'whatsapp_number':'email_address'];
    const verified=await db.query(`select d.id from staff_notification_destinations d join channels c on c.client_id=d.client_id and c.kind::text=d.kind
      join users u on u.id=d.recipient_user_id and u.client_id=d.client_id and u.role='client'
      where d.client_id=$1 and d.kind=$2 and d.destination=$3 and d.enabled=true and d.verified_at is not null and c.status='active'
      and exists(select 1 from staff_permission_grants g where g.client_id=$1 and g.user_id=u.id and g.permission in ('conversation.respond','conversation.release')) limit 1`,[clientId,kind,destination]);
    if(!verified.rowCount)throw new SelfServeError(`Set up and verify this ${kind==='whatsapp'?'WhatsApp':'email'} alert destination before enabling it.`,409);
   }
   await db.query('update selfserve_settings set alerts=$2 where client_id=$1',[clientId,alerts]);
  }else throw new SelfServeError('Choose settings to update.');
  await touch(db,clientId);await recordAuditLog({clientId,actorUserId:actorId,action:'selfserve.settings_saved',targetType:'client',targetId:clientId,metadata:{section:input.handovers?'handovers':'alerts'}},db);
 });
}
export async function addSource(clientId:string,actorId:string,input:{id:string;type:'text'|'url'|'file';label:string;text?:string;url?:string;file?:unknown;meta?:unknown}){
 return transaction(async db=>{
  await lockSettings(db,clientId);
  const old=(await db.query<{id:string}>('select id from selfserve_sources where client_id=$1 and id=$2',[clientId,input.id])).rows[0];if(old)return old;
  const count=await db.query<{count:string}>('select count(*) from selfserve_sources where client_id=$1 and deleted_at is null',[clientId]);if(Number(count.rows[0].count)>=100)throw new SelfServeError('This workspace supports up to 100 sources. Remove an old source first.');
  await db.query('insert into selfserve_sources(id,client_id,type,label,raw_text,url,transient_file,file_meta) values($1,$2,$3,$4,$5,$6,$7,$8)',[input.id,clientId,input.type,input.label,input.text??null,input.url??null,input.file??null,input.meta??null]);
  await queueJob(db,clientId,actorId,'source',input.id,1);await touch(db,clientId,true);
  await recordAuditLog({clientId,actorUserId:actorId,action:'selfserve.source_added',targetType:'source',targetId:input.id,metadata:{type:input.type}},db);return {id:input.id};
 });
}
export async function addHandovers(clientId:string,actorId:string,text:string,version:unknown,id:string=randomUUID()){
 return transaction(async db=>{const s=await lockSettings(db,clientId);checkRevision(s,version);return {id:await queueJob(db,clientId,actorId,'handovers',id,1,{text:z.string().trim().min(1).max(10000).parse(text),version})};});
}
export async function retrySource(clientId:string,actorId:string,id:string){
 return transaction(async db=>{
  await lockSettings(db,clientId);
  const source=(await db.query<{revision:number;type:string;extracted_text:string|null}>("select revision,type,extracted_text from selfserve_sources where client_id=$1 and id=$2 and deleted_at is null and status='failed' for update",[clientId,id])).rows[0];
  if(!source)throw new SelfServeError('Failed source not found.',404);
  if(source.type==='file'&&!source.extracted_text)throw new SelfServeError('Upload this file again; the temporary original has been deleted.');
  await db.query("update selfserve_sources set status='processing',error=null,revision=revision+1,type=case when extracted_text is not null then 'text' else type end,raw_text=coalesce(extracted_text,raw_text),updated_at=now() where client_id=$1 and id=$2",[clientId,id]);
  await queueJob(db,clientId,actorId,'source',id,source.revision+1);await touch(db,clientId,true);
 });
}
