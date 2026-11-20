import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,transaction} from '@/lib/db';
import {scenarios,type Industry} from './catalog';
import {getSettings,queueJob,SelfServeError,touch,lockSettings,checkRevision} from './store';
import {selfServeModel,notesSchema,situationsSchema,previewSchema} from './model';
import {updateJob,cancel,assertJobLease,type Job} from './jobs';
import {openFile,extractFile,extractChatArchive,type PrivateFile} from './files';
type Reply={round:number;customer_message:string;owner_reply:string};
export type VoiceSession={id:string;client_id:string;actor_id:string;method:'conversation'|'upload';industry:Industry;status:string;revision:number;replies:Reply[];transient_file:unknown;review_text:string|null;speaker_options:string[];selected_speaker:string|null;draft_notes:string[];expires_at:Date;error:string|null};
export async function voiceSession(clientId:string,actorId:string,id:string){
 const row=(await query<VoiceSession>('select * from selfserve_voice_sessions where client_id=$1 and id=$2 and actor_id=$3',[clientId,id,actorId])).rows[0];
 if(!row)throw new SelfServeError('Voice session not found.',404);
 return {...row,transient_file:undefined,review_text:row.expires_at.getTime()>Date.now()?row.review_text:null};
}
export async function createVoiceSession(clientId:string,actorId:string,id:string,method:'conversation'|'upload',files?:unknown){
 const settings=await getSettings(clientId);if(!settings)throw new SelfServeError('Workspace unavailable.',503);
 await query(`insert into selfserve_voice_sessions(id,client_id,actor_id,method,industry,status,transient_file) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing`,[id,clientId,actorId,method,settings.industry,files?'extracting':'collecting',files??null]);
 const session=await voiceSession(clientId,actorId,id);if(session.method!==method)throw new SelfServeError('This request ID has already been used.',409);
 if(files)await transaction(db=>queueJob(db,clientId,actorId,'voice_extract',id,session.revision));return session;
}
export async function addVoiceReply(clientId:string,actorId:string,id:string,round:number,reply:string){
 const text=z.string().trim().min(1).max(2000).parse(reply);
 await transaction(async db=>{
  const session=(await db.query<VoiceSession>('select * from selfserve_voice_sessions where client_id=$1 and id=$2 and actor_id=$3 for update',[clientId,id,actorId])).rows[0];
  if(!session||session.method!=='conversation'||session.expires_at.getTime()<Date.now())throw new SelfServeError('Start a new voice session.',404);
  const old=session.replies.find(r=>r.round===round);if(old){if(old.owner_reply===text)return;throw new SelfServeError('That round has already been answered.',409);}
  if(session.status!=='collecting'||session.replies.length!==round-1||round<1||round>3)throw new SelfServeError('Reload this conversation before replying.',409);
  const replies=[...session.replies,{round,customer_message:scenarios[session.industry].messages[round-1],owner_reply:text}];
  await db.query(`update selfserve_voice_sessions set replies=$4,status=$5,revision=revision+1,updated_at=now() where client_id=$1 and id=$2 and actor_id=$3`,[clientId,id,actorId,JSON.stringify(replies),round===3?'analysing':'collecting']);
  if(round===3)await queueJob(db,clientId,actorId,'voice_analyse',id,session.revision+1);
 });return voiceSession(clientId,actorId,id);
}
export function parseWhatsApp(text:string){
 const messages:Array<{speaker:string;body:string}>=[];
 for(const line of text.replace(/\r/g,'').split('\n')){
  const match=line.match(/^(?:\[[\d/.,:\sAPMapm-]+\]|[\d/.,:\sAPMapm]+\s[-–])\s*([^:\n]{1,100}):\s*(.*)$/u);
  if(match){if(!/media omitted|image omitted|messages.*encrypted/i.test(match[2]))messages.push({speaker:match[1].trim(),body:match[2]});}
  else if(messages.length&&!/end.to.end encrypted|security code changed|joined using|created group|<Media omitted>/i.test(line))messages[messages.length-1].body+='\n'+line;
 }
 return messages;
}
export function redactSamples(text:string,names:string[]=[]){
 let result=text;
 for(const name of [...new Set(names)].sort((a,b)=>b.length-a.length))if(name.length>=2)result=result.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu'),'[name]');
 return result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/(?:\+\d[\d ()-]{6,}\d|\b\d{8,15}\b)/g,'[number]').replace(/https?:\/\/\S+/g,'[link]');
}
export async function analyseUpload(clientId:string,actorId:string,id:string,speaker:string,text:string){
 const sample=z.string().trim().min(20).max(30000).parse(text);
 return transaction(async db=>{
  const session=(await db.query<VoiceSession>('select * from selfserve_voice_sessions where client_id=$1 and id=$2 and actor_id=$3 for update',[clientId,id,actorId])).rows[0];
  if(!session||session.status!=='review'||session.expires_at.getTime()<Date.now())throw new SelfServeError('Upload review expired. Start again.',409);
  if(session.speaker_options.length)throw new SelfServeError('Select the business participant before reviewing its messages.');
  const reviewed=redactSamples(sample);
  await db.query(`update selfserve_voice_sessions set review_text=$4,selected_speaker=$5,speaker_options='[]',status='analysing',revision=revision+1,updated_at=now() where client_id=$1 and id=$2 and actor_id=$3`,[clientId,id,actorId,reviewed,speaker]);
  await queueJob(db,clientId,actorId,'voice_analyse',id,session.revision+1);
 });
}
export async function selectSpeaker(clientId:string,actorId:string,id:string,speaker:string){
 await transaction(async db=>{
  const session=(await db.query<VoiceSession>('select * from selfserve_voice_sessions where client_id=$1 and id=$2 and actor_id=$3 for update',[clientId,id,actorId])).rows[0];
  if(!session||session.status!=='review'||session.expires_at.getTime()<Date.now()||!session.speaker_options.includes(speaker))throw new SelfServeError('Choose a participant from this export.');
  const messages=parseWhatsApp(session.review_text??'');const selected=messages.filter(m=>m.speaker===speaker).map(m=>m.body).join('\n\n');
  await db.query("update selfserve_voice_sessions set review_text=$4,selected_speaker=$5,speaker_options='[]',revision=revision+1 where client_id=$1 and id=$2 and actor_id=$3",[clientId,id,actorId,redactSamples(selected,messages.map(m=>m.speaker)),speaker]);
 });return voiceSession(clientId,actorId,id);
}
export async function discardVoice(clientId:string,actorId:string,id:string){await query(`update selfserve_voice_sessions set status='discarded',revision=revision+1,replies='[]',review_text=null,transient_file=null,upload_meta='[]',speaker_options='[]',selected_speaker=null where client_id=$1 and id=$2 and actor_id=$3`,[clientId,id,actorId]);}
export async function processVoiceJob(job:Job){
 if(job.kind==='handovers'){
  const text=z.string().trim().min(1).max(10000).parse(job.payload.text);
  const output=await selfServeModel(job.client_id,'handovers','Extract separate handover situations by meaning. Keep every qualifier and original language; one self-contained situation per item. No invented triggers or authority. Lists of independent situations should become separate items.',{text},situationsSchema);
  await transaction(async db=>{const settings=await lockSettings(db,job.client_id);await assertJobLease(db,job);if(job.payload.baseHandovers){if(job.payload.baseHandovers!==JSON.stringify(settings.handovers))throw new SelfServeError('Handover settings changed during analysis. Review and add this situation again.',409);}else checkRevision(settings,job.payload.version);
   settings.handovers.custom.push(...output.value.situations.map(text=>({id:randomUUID(),text})));
   await db.query('update selfserve_settings set handovers=$2 where client_id=$1',[job.client_id,settings.handovers]);await touch(db,job.client_id);await updateJob(job,{added:output.value.situations.length},'ready',db,output.model);
  });return;
 }
 if(job.kind==='preview'){
  const settings=await getSettings(job.client_id);if(!settings)throw new Error('Workspace unavailable.');
  const notes=z.array(z.string().max(1600)).max(20).parse(job.payload.notes);
  const question=scenarios[settings.industry].preview;
  const output=await selfServeModel(job.client_id,'preview',`Write one short illustrative reply showing only the supplied voice. The customer requests a booking/appointment CHANGE. You cannot perform it or promise availability. Firmly say our team will review the request, optionally asking one useful missing detail. Never say booked, moved, confirmed, processed or done. No invented facts, fees or policy. Return plain text.`,{notes,question},previewSchema);
  if(/\b(?:i|we)(?:['’]ve| have)?\s+(?:moved|changed|booked|confirmed)|\b(?:all set|done|no prob.*moved)\b/i.test(output.value.reply))throw new Error('Preview implied an unsupported action.');
  await updateJob(job,{question,reply:output.value.reply},'ready',undefined,output.model);return;
 }
 const session=(await query<VoiceSession>('select * from selfserve_voice_sessions where client_id=$1 and id=$2 and revision=$3 and actor_id=$4',[job.client_id,job.target_id,job.revision,job.actor_id])).rows[0];
 if(!session||['discarded','saved'].includes(session.status)||session.expires_at.getTime()<Date.now()){await cancel(job);return;}
 if(job.kind==='voice_extract'){
  const wrapped=openFile(session.transient_file);const list=JSON.parse(wrapped.data) as PrivateFile[];const files:PrivateFile[]=[];
  for(const f of list){if(f.name.toLowerCase().endsWith('.zip'))files.push(...await extractChatArchive(f));else files.push(f);}
  const chats:string[]=[],images:string[]=[];
  for(const file of files){if(file.name.toLowerCase().endsWith('.txt'))chats.push(Buffer.from(file.data,'base64').toString('utf8'));else images.push((await extractFile(file)).map(s=>s.text).join('\n'));}
  const messages=chats.flatMap(parseWhatsApp),speakers=[...new Set(messages.map(m=>m.speaker))];
  if(chats.length&&!speakers.length)throw new Error('Could not identify participants in this export.');
  const review=messages.length?messages.map(m=>`[20/11/26, 00:00] ${m.speaker}: ${m.body}`).join('\n'):redactSamples(images.join('\n\n'));
  if(!review.trim()||review.length>100000)throw new Error('Choose smaller readable chat samples.');
  await transaction(async db=>{
   await lockSettings(db,job.client_id);await assertJobLease(db,job);
   await db.query(`update selfserve_voice_sessions set status='review',transient_file=null,review_text=$5,speaker_options=$6,updated_at=now() where client_id=$1 and id=$2 and revision=$3 and actor_id=$4 and status='extracting' and expires_at>now()`,[job.client_id,session.id,job.revision,job.actor_id,review,JSON.stringify(speakers)]);
   await updateJob(job,{reviewReady:true},'ready',db);
  });return;
 }
 const messages=session.method==='conversation'?session.replies.map(r=>r.owner_reply):[session.review_text??''];
 const output=await selfServeModel(job.client_id,'voice','Describe only OBSERVABLE writing style in the business-side samples. Output 3–8 short, specific, editable notes covering supported evidence for length, greetings, casing, emoji, punctuation, local shorthand and complaint tone. Do not infer unsupported traits; never turn sample policies, prices, booking actions or customer facts into instructions. No person names, numbers, contact information, medical/customer details or quotes from private conversations. Do not manufacture a voice when evidence is insufficient.',{industry:session.industry,samples:messages},notesSchema);
 const cleaned=output.value.notes.map(note=>redactSamples(note));
 await transaction(async db=>{
  await lockSettings(db,job.client_id);await assertJobLease(db,job);
  await db.query(`update selfserve_voice_sessions set status='ready',draft_notes=$5,review_text=null,replies=case when method='upload' then '[]'::jsonb else replies end,model=$6,prompt_version=$7,updated_at=now() where client_id=$1 and id=$2 and revision=$3 and actor_id=$4 and status='analysing'`,[job.client_id,session.id,job.revision,job.actor_id,JSON.stringify(cleaned),output.model,'selfserve-v1']);
  await updateJob(job,{notesReady:true},'ready',db,output.model);
 });
}
