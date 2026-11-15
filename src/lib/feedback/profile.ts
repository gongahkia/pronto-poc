import 'server-only';
import {createAnonymousIdentity} from '@huddle/host';
import {getSessionUser} from '@/lib/auth';
import {transaction} from '@/lib/db';
import {recordAuditLog} from '@/lib/audit';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {cleanGuestName} from '@/lib/guest-access';
import {isGuestEmail} from '@/lib/guest-policy';
import {assertFeedbackActor} from './authorization';
import {assertFeedbackEnabled,lockFeedbackTransaction} from './state';

async function requestedName(request:Request):Promise<string>{
 const reader=request.body?.getReader();if(!reader)throw new DemoError('Provide a reviewer name.',400);const bytes=new Uint8Array(2048);let size=0;
 try{while(true){const next=await reader.read();if(next.done)break;if(size+next.value.byteLength>bytes.length){await reader.cancel();throw new DemoError('The name request is too large.',413);}bytes.set(next.value,size);size+=next.value.byteLength;}}finally{reader.releaseLock();}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}catch{throw new DemoError('Provide a valid name request.',400);}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.prototype.hasOwnProperty.call(value,'name')||typeof Reflect.get(value,'name')!=='string')throw new DemoError('Provide only your reviewer name.',400);
 const raw=Reflect.get(value,'name') as string;if(raw.length>40)throw new DemoError('Use a name of 40 characters or fewer.',400);
 const name=raw.trim()?cleanGuestName(raw):createAnonymousIdentity().name;if(!name)throw new DemoError('Enter a name or leave it blank for a suggested name.',400);return name;
}
export async function updateFeedbackReviewerName(request:Request):Promise<{name:string}>{
 assertFeedbackEnabled();const actor=await assertFeedbackActor(await getSessionUser());if(!isGuestEmail(actor.email))throw new DemoError('Change this account’s name through its existing account settings.',403);const name=await requestedName(request);
 return transaction(async db=>{
  await lockFeedbackTransaction(db,'huddle');await assertFeedbackActor(actor,db);
  const window=new Date(Math.floor(Date.now()/60000)*60000),attempts=await db.query<{attempts:number}>(`insert into auth_login_attempts(key,window_start,attempts) values($1,$2,1) on conflict(key,window_start) do update set attempts=auth_login_attempts.attempts+1 returning attempts`,['feedback:name:'+actor.userId,window]);
  if(attempts.rows[0].attempts>20)throw new DemoError('Too many name changes. Please try again in a minute.',429);
  const updated=await db.query<{name:string}>(`update users set name=$1 where id=$2 and client_id=$3 and role='client' and lower(email) like $4 returning name`,[name,actor.userId,DEMO_CLIENT_ID,'%@guest.invalid']);
  if(!updated.rows.length)throw new DemoError('This reviewer session is no longer available.',403);
  await recordAuditLog({clientId:DEMO_CLIENT_ID,actorUserId:actor.userId,action:'feedback.reviewer_name_changed',targetType:'user',targetId:actor.userId,metadata:{name}},db);return {name:updated.rows[0].name};
 });
}
