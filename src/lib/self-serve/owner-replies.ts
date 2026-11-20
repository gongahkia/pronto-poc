import {transaction} from '@/lib/db';
import {recordAuditLog} from '@/lib/audit';
import {selfServeUIEnabled} from './settings';
import {getSettings} from './store';
import type {Channel} from '@/lib/types';
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
export type OwnerEcho={messageId:string;threadId:string;occurredAt:Date;body:string};
function timestamp(value:unknown){const n=Number(value);if(!Number.isFinite(n)||n<1)return null;const d=new Date(n<1e12?n*1000:n);return Number.isFinite(d.getTime())&&d.getTime()<=Date.now()+60000?d:null;}
export function instagramOwnerEchoes(payload:Record<string,unknown>,account:string,appId?:string):OwnerEcho[]{
 const echoes:OwnerEcho[]=[];if(payload.object!=='instagram')return echoes;
 for(const entry of Array.isArray(payload.entry)?payload.entry:[]){if(!record(entry)||entry.id!==account)continue;
  for(const event of Array.isArray(entry.messaging)?entry.messaging:[]){
   if(!record(event)||!record(event.message)||!record(event.sender)||!record(event.recipient))continue;const m=event.message;
   // Other apps are automation too. Only a native echo without an app id can
   // release a handover; this also covers an API echo racing its saved receipt.
   if(m.is_echo!==true||m.app_id||event.sender.id!==account||typeof event.recipient.id!=='string'||event.recipient.id===account||typeof m.mid!=='string'||typeof m.text!=='string'||!m.text.trim())continue;
   if(appId&&String(m.app_id??'')===appId)continue;const occurredAt=timestamp(event.timestamp);if(occurredAt)echoes.push({messageId:m.mid,threadId:event.recipient.id,occurredAt,body:m.text});
  }
 }return echoes;
}
export function whatsAppOwnerEchoes(payload:Record<string,unknown>,phoneNumberId:string):OwnerEcho[]{
 const echoes:OwnerEcho[]=[];if(payload.object!=='whatsapp_business_account')return echoes;
 for(const entry of Array.isArray(payload.entry)?payload.entry:[]){if(!record(entry))continue;
  for(const change of Array.isArray(entry.changes)?entry.changes:[]){if(!record(change)||change.field!=='smb_message_echoes'||!record(change.value))continue;const v=change.value;
   if(!record(v.metadata)||v.metadata.phone_number_id!==phoneNumberId)continue;
   for(const m of Array.isArray(v.message_echoes)?v.message_echoes:[]){if(!record(m)||m.type!=='text'||!record(m.text)||typeof m.text.body!=='string'||!m.text.body.trim()||typeof m.id!=='string')continue;
    const thread=typeof m.to==='string'?m.to:typeof m.to_user_id==='string'?m.to_user_id:null;const occurredAt=timestamp(m.timestamp);if(thread&&occurredAt)echoes.push({messageId:m.id,threadId:thread,occurredAt,body:m.text.body});
   }
  }
 }return echoes;
}
// Only called after the existing channel HMAC, account and tester checks.
export async function recordNativeOwnerReply(channel:Pick<Channel,'id'|'client_id'>,echo:OwnerEcho){
 if(!selfServeUIEnabled())return false;
 return transaction(async db=>{
  if(!(await getSettings(channel.client_id,db))?.enabled)return false;
  const conversation=(await db.query<{id:string;status:string}>(`select id,status from conversations where client_id=$1 and channel_id=$2 and external_thread_id=$3 and deleted_at is null for update`,[channel.client_id,channel.id,echo.threadId])).rows[0];if(!conversation||conversation.status!=='escalated')return false;
  const apiEcho=await db.query(`select id from outbound_messages where client_id=$1 and channel_id=$2 and (metadata->>'providerMessageId'=$3 or (external_thread_id=$4 and status in ('sending','uncertain'))) limit 1`,[channel.client_id,channel.id,echo.messageId,echo.threadId]);if(apiEcho.rowCount)return false;
  const holds=await db.query<{id:string}>(`select e.id from escalations e join messages m on m.id=e.message_id and m.client_id=e.client_id where e.client_id=$1 and e.conversation_id=$2 and e.status in ('open','claimed')
   and (e.created_at>$3 or coalesce((m.metadata->>'providerOccurredAt')::timestamptz,m.created_at)>=$3)`,[channel.client_id,conversation.id,echo.occurredAt]);if(holds.rowCount)return false;
  const seen=await db.query(`insert into selfserve_owner_replies(client_id,channel_id,external_message_id,external_thread_id,occurred_at) values($1,$2,$3,$4,$5) on conflict(channel_id,external_message_id) do nothing returning id`,[channel.client_id,channel.id,echo.messageId,echo.threadId,echo.occurredAt]);if(!seen.rowCount)return false;
  await db.query(`insert into messages(client_id,channel_id,conversation_id,external_message_id,sender_role,body,metadata) values($1,$2,$3,$4,'operator',$5,$6) on conflict(channel_id,external_message_id) do nothing`,[channel.client_id,channel.id,conversation.id,echo.messageId,echo.body,{nativeOwnerReply:true,providerOccurredAt:echo.occurredAt.toISOString()}]);
  await db.query("update escalations set status='resolved',resolved_at=now(),allow_ai_followups=false where client_id=$1 and conversation_id=$2 and status in ('open','claimed')",[channel.client_id,conversation.id]);
  // Old work stays skipped. Resuming is permission for a new customer turn.
  await db.query("update inbound_jobs set status='skipped',updated_at=now(),last_error='Native owner replied; old backlog was not replayed.' where client_id=$1 and conversation_id=$2 and status in ('pending','failed','processing')",[channel.client_id,conversation.id]);
  await db.query("update conversations set status='active',ai_should_respond=true,owner_action_required=false,last_message_at=now() where client_id=$1 and id=$2",[channel.client_id,conversation.id]);
  await recordAuditLog({clientId:channel.client_id,actorUserId:null,action:'selfserve.native_owner_resumed',targetType:'conversation',targetId:conversation.id,metadata:{channelId:channel.id,providerMessageId:echo.messageId,onlyFutureCustomerTurns:true}},db);return true;
 });
}
