import {NextResponse} from 'next/server';
import {z} from 'zod';
import {getSessionUser} from '@/lib/auth';
import {enterTenantContext} from '@/lib/tenant-context';
import {hasStaffCapability} from '@/lib/staff-permissions';
import {assertSameOrigin} from '@/lib/http/csrf';
import {query,transaction} from '@/lib/db';
import {logWarn} from '@/lib/logger';
import {initializeSelfServe,snapshot,saveVoice,editRule,removeRule,removeSource,queueJob,SelfServeError} from '@/lib/self-serve/store';
import {selfServeUIEnabled,updateSettings,addSource,addHandovers,retrySource} from '@/lib/self-serve/settings';
import {MAX_SOURCE_BYTES,sealFile,type PrivateFile} from '@/lib/self-serve/files';
import {createVoiceSession,voiceSession,addVoiceReply,selectSpeaker,analyseUpload,discardVoice} from '@/lib/self-serve/voice';
export const maxDuration=180;
export const dynamic='force-dynamic';
type Context={params:Promise<{path?:string[]}>};
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
async function handle(request:Request,context:Context){
 if(!selfServeUIEnabled())return json({error:'Self-serve is not enabled.'},404);
 const write=request.method!=='GET';if(write){const csrf=assertSameOrigin(request);if(csrf)return csrf;}
 const actor=await getSessionUser();if(!actor)return json({error:'Sign in to continue.'},401);
 if(actor.role!=='client'||!actor.clientId)return json({error:'A business membership is required.'},403);
 enterTenantContext(actor);const clientId=actor.clientId;
 const path=(await context.params).path??[];const [section,id,action]=path;
 const required=section==='settings'||section==='handovers'?'escalation.policy.manage':'knowledge.approve';
 if(!await hasStaffCapability(actor,clientId,required))return json({error:'Your account does not have permission to manage these settings.'},403);
 try{
  if(request.method==='GET'){
   if(!section)return json(await snapshot(clientId));
   if(section==='voice-sessions'&&id)return json(await voiceSession(clientId,actor.userId,z.uuid().parse(id)));
   if(section==='jobs'&&id){const row=(await query('select id,kind,status,error,result from selfserve_jobs where client_id=$1 and id=$2 and actor_id=$3',[clientId,z.uuid().parse(id),actor.userId])).rows[0];if(!row)throw new SelfServeError('Job not found.',404);return json(row);}
   throw new SelfServeError('Not found.',404);
  }
  if(section==='process'&&request.method==='POST'){
   const {processSelfServeJobs}=await import('@/lib/self-serve/jobs');return json(await processSelfServeJobs(clientId));
  }
  if(section==='initialize'&&request.method==='POST'){await initializeSelfServe(clientId,actor.userId);return json(await snapshot(clientId));}
  // Bound the stream before parsing multipart or JSON, including chunked uploads.
  const max=section==='sources'||section==='voice-sessions'?MAX_SOURCE_BYTES+256*1024:100000;
  if(Number(request.headers.get('content-length'))>max)throw new SelfServeError('Upload exceeds the 25 MB limit.',413);
  const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new SelfServeError('Request exceeds its size limit.',413);}chunks.push(value);}
  const body=Buffer.concat(chunks);const multipart=request.headers.get('content-type')?.includes('multipart/form-data');
  const form=multipart?await new Response(body,{headers:{'Content-Type':request.headers.get('content-type')!}}).formData():null;
  const data:Record<string,unknown>=form?Object.fromEntries(form.entries()):body.length?JSON.parse(body.toString()):{};
  if(section==='sources'&&!id&&request.method==='POST'){
   const type=z.enum(['text','file','url']).parse(data.type),sourceId=z.uuid().parse(data.id),label=z.string().trim().min(1).max(160).parse(data.label);
   if(type==='file'){
    const file=form?.get('file');if(!(file instanceof File)||!file.size||file.size>MAX_SOURCE_BYTES)throw new SelfServeError('Choose one nonempty file of up to 25 MB.');
    if(!/\.(pdf|docx?|txt|md|csv|xlsx|jpe?g|png|webp|heic)$/i.test(file.name))throw new SelfServeError('Choose a supported document or image.');
    await addSource(clientId,actor.userId,{id:sourceId,type,label,file:sealFile({name:file.name,type:file.type,data:Buffer.from(await file.arrayBuffer()).toString('base64')}),meta:{name:file.name,size:file.size,mime:file.type}});
   }else if(type==='text')await addSource(clientId,actor.userId,{id:sourceId,type,label,text:z.string().trim().min(1).max(10000).parse(data.text)});
   else{const url=z.url().max(2000).parse(data.url);const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new SelfServeError('Enter a public http or https page URL.');await addSource(clientId,actor.userId,{id:sourceId,type,label,url});}
  }else if(section==='sources'&&id){z.uuid().parse(id);if(request.method==='DELETE')await removeSource(clientId,actor.userId,id,data.version);else if(action==='retry'&&request.method==='POST')await retrySource(clientId,actor.userId,id);else throw new SelfServeError('Not found.',404);
  }else if(section==='rules'&&id){z.uuid().parse(id);if(request.method==='PATCH')await editRule(clientId,actor.userId,id,data.text,data.version);else if(request.method==='DELETE'||action==='keep')await removeRule(clientId,actor.userId,id,data.version,action==='keep');else throw new SelfServeError('Not found.',404);
  }else if(section==='settings'&&request.method==='PATCH')await updateSettings(clientId,actor.userId,data);
  else if(section==='handovers'&&request.method==='POST')return json(await addHandovers(clientId,actor.userId,String(data.text??''),data.version,z.uuid().parse(data.id)));
  else if(section==='voice'&&request.method==='PUT')await saveVoice(clientId,actor.userId,data as Parameters<typeof saveVoice>[2]);
  else if(section==='preview'&&request.method==='POST')return json({id:await transaction(db=>queueJob(db,clientId,actor.userId,'preview',z.uuid().parse(data.id),1,{notes:z.array(z.string().max(1600)).min(1).max(20).parse(data.notes)}))});
  else if(section==='voice-sessions'){
   if(!id&&request.method==='POST'){
    const sessionId=z.uuid().parse(data.id),method=z.enum(['conversation','upload']).parse(data.method);let sealed;
    if(method==='upload'){
     if(!form||data.consent!=='true')throw new SelfServeError('Confirm permission to analyse these samples.');const files=form.getAll('files');if(!files.length||files.length>10)throw new SelfServeError('Choose 1–10 chat exports or screenshots, up to 25 MB in total.');
     const list:PrivateFile[]=[];for(const file of files){if(!(file instanceof File)||!file.size||!/\.(txt|zip|jpe?g|png|webp|heic)$/i.test(file.name))throw new SelfServeError('Upload a WhatsApp TXT/ZIP export or chat screenshot.');list.push({name:file.name,type:file.type,data:Buffer.from(await file.arrayBuffer()).toString('base64')});}
     if(list.some(f=>/\.(txt|zip)$/i.test(f.name))&&list.some(f=>!(/\.(txt|zip)$/i.test(f.name))))throw new SelfServeError('Choose chat exports or screenshots for one session; do not mix them.');
     sealed=sealFile({name:'voice-samples',type:'application/json',data:JSON.stringify(list)});
    }return json(await createVoiceSession(clientId,actor.userId,sessionId,method,sealed));
   }
   z.uuid().parse(id);
   if(request.method==='DELETE')await discardVoice(clientId,actor.userId,id!);
   else if(action==='reply')return json(await addVoiceReply(clientId,actor.userId,id!,z.number().int().parse(data.round),String(data.reply??'')));
   else if(action==='speaker')return json(await selectSpeaker(clientId,actor.userId,id!,String(data.speaker??'')));
   else if(action==='analyse'){if(data.consent!==true)throw new SelfServeError('Confirm these are permissioned business-side samples.');await analyseUpload(clientId,actor.userId,id!,String(data.speaker??''),String(data.text??''));return json(await voiceSession(clientId,actor.userId,id!));}
   else throw new SelfServeError('Not found.',404);
  }else throw new SelfServeError('Not found.',404);
  return json(await snapshot(clientId));
 }catch(error){
  if(error instanceof SelfServeError)return json({error:error.message},error.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Check the submitted fields and try again.'},400);
  logWarn('selfserve.request_failed',{clientId,error});return json({error:'This change could not be saved. Reload and try again.'},503);
 }
}
let uploadActive=false;
export async function POST(request:Request,context:Context){
 if(!request.headers.get('content-type')?.includes('multipart/form-data'))return handle(request,context);
 if(uploadActive)return json({error:'Another upload is being saved. Try again in a moment.'},429);
 uploadActive=true;try{return await handle(request,context);}finally{uploadActive=false;}
}
export const GET=handle;export const PUT=handle;export const PATCH=handle;export const DELETE=handle;
