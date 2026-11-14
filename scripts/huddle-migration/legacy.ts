import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Anchor,Attribution,Comment,FeedbackSnapshot,History,Json,Thread} from '@huddle/browser';
export type LegacyThread = {id:string;client_id:string;page_path:string;anchor_json:string;status:'open'|'resolved';created_by_user_id:string|null;created_at:string;updated_at:string};
export type LegacyComment = {id:string;client_id:string;thread_id:string;author_user_id:string|null;author_name:string;body:string;request_id:string|null;created_at:string};
export type LegacyBackup = {schema:'pronto.feedback.backup.v1';complete:true;datasetId:string;workspaceId:string;origin:string;capturedAt:string;counts:{threads:number;comments:number};threads:LegacyThread[];comments:LegacyComment[];creators:{id:string;name:string}[]};
export const canonical = (value:unknown):string => {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value === 'object') return '{'+Object.entries(value).filter(([,item]) => item !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value);
};
export const sha256 = (value:string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function sourceDigest(source:LegacyBackup) {return sha256(canonical({...source,capturedAt:undefined}));}
function text(value:unknown,name:string,max:number,min=1):asserts value is string {if(typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`Legacy ${name} exceeds the neutral field limit or is invalid; source data has not been truncated.`);}
function timestamp(value:unknown) {text(value,'timestamp',100);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Legacy timestamp must preserve its exact UTC instant.');}
export function validateBackup(value:unknown,maxBytes=32*1024*1024):LegacyBackup {
  if(!value || typeof value !== 'object') throw new Error('Choose a complete legacy feedback backup.');const source = value as LegacyBackup;
  if(source.schema !== 'pronto.feedback.backup.v1' || source.complete !== true || !Array.isArray(source.threads) || !Array.isArray(source.comments) || !Array.isArray(source.creators) || source.counts?.threads !== source.threads.length || source.counts?.comments !== source.comments.length || source.threads.length+source.comments.length > 100000 || Buffer.byteLength(JSON.stringify(source)) > maxBytes) throw new Error('Legacy backup is incomplete or exceeds its configured byte/record bounds.');
  text(source.datasetId,'dataset ID',512);text(source.workspaceId,'workspace ID',512);timestamp(source.capturedAt);const origin = new URL(source.origin);if(!['http:','https:'].includes(origin.protocol) || origin.origin !== source.origin || origin.username || origin.password) throw new Error('Choose an exact HTTP(S) source origin without credentials.');
  const threads = new Set<string>(), comments = new Set<string>(), creators = new Set<string>();
  for(const thread of source.threads) {text(thread.id,'thread ID',512);if(threads.has(thread.id) || thread.client_id !== source.workspaceId || !['open','resolved'].includes(thread.status)) throw new Error('Legacy thread identity/scope/status is inconsistent.');threads.add(thread.id);text(thread.page_path,'page path',maxBytes);text(thread.anchor_json,'anchor JSON',maxBytes);timestamp(thread.created_at);timestamp(thread.updated_at);if(thread.created_by_user_id !== null) text(thread.created_by_user_id,'creator ID',512);}
  for(const comment of source.comments) {text(comment.id,'comment ID',512);if(comments.has(comment.id) || comment.client_id !== source.workspaceId || !threads.has(comment.thread_id)) throw new Error('Legacy comment identity or thread reference is inconsistent.');comments.add(comment.id);text(comment.author_name,'author name',maxBytes);text(comment.body,'comment body',maxBytes);timestamp(comment.created_at);if(comment.author_user_id !== null) text(comment.author_user_id,'author ID',512);if(comment.request_id !== null) text(comment.request_id,'request ID',512);}
  const referencedCreators = new Set(source.threads.map(thread => thread.created_by_user_id));
  for(const creator of source.creators) {text(creator.id,'creator ID',512);text(creator.name,'creator name',maxBytes);if(creators.has(creator.id) || !referencedCreators.has(creator.id)) throw new Error('Legacy creator snapshot is ambiguous or unrelated.');creators.add(creator.id);}
  return source;
}
export async function readLegacy(pool:Pool,input:{workspaceId:string;datasetId:string;origin:string;maxBytes?:number},existing?:PoolClient):Promise<LegacyBackup> {
  const db = existing ?? await pool.connect(), maxBytes = input.maxBytes ?? 32*1024*1024;
  try {
    if(!existing) await db.query('begin isolation level repeatable read read only');
    for(const [table,expected] of Object.entries({demo_feedback_threads:['id','client_id','page_path','anchor','status','created_by_user_id','created_at','updated_at'],demo_feedback_comments:['id','client_id','thread_id','author_user_id','author_name','body','created_at','request_id']})) {
      const columns = (await db.query<{column_name:string}>('select column_name from information_schema.columns where table_schema=\'public\' and table_name=$1 order by column_name',[table])).rows.map(row => row.column_name);
      if(canonical(columns) !== canonical(expected.sort())) throw new Error('Legacy feedback schema differs from the reviewed migration inventory; stop and preserve every added field.');
    }
    const size = (await db.query<{bytes:string;records:string}>(`select coalesce(sum(bytes),0)::text bytes,coalesce(sum(records),0)::text records from (
      select coalesce(sum(octet_length(row_to_json(t)::text)),0) bytes,count(*) records from demo_feedback_threads t where client_id=$1
      union all select coalesce(sum(octet_length(row_to_json(c)::text)),0),count(*) from demo_feedback_comments c where client_id=$1) sizes`,[input.workspaceId])).rows[0];
    if(!Number.isSafeInteger(Number(size.bytes)) || Number(size.bytes) > maxBytes || Number(size.records) > 100000) throw new Error('Legacy source exceeds the configured snapshot limits; no records were truncated or migrated.');
    const threads = (await db.query<LegacyThread>(`select id::text,client_id::text,page_path,anchor::text anchor_json,status,created_by_user_id::text,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') updated_at
      from demo_feedback_threads where client_id=$1 order by id`,[input.workspaceId])).rows;
    const comments = (await db.query<LegacyComment>(`select id::text,client_id::text,thread_id::text,author_user_id::text,author_name,body,request_id::text,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at from demo_feedback_comments where client_id=$1 order by id`,[input.workspaceId])).rows;
    const creators = (await db.query<{id:string;name:string}>(`select id::text,name from users where id in(select created_by_user_id from demo_feedback_threads where client_id=$1) order by id`,[input.workspaceId])).rows;
    const source = validateBackup({schema:'pronto.feedback.backup.v1',complete:true,datasetId:input.datasetId,workspaceId:input.workspaceId,origin:input.origin,capturedAt:new Date().toISOString(),counts:{threads:threads.length,comments:comments.length},threads,comments,creators},maxBytes);
    if(!existing) await db.query('commit');return source;
  } catch(error) {if(!existing) await db.query('rollback').catch(() => {});throw error;} finally {if(!existing) db.release();}
}
function anchorFor(thread:LegacyThread):Anchor {
  let value:Record<string,unknown>;try {value = JSON.parse(thread.anchor_json);} catch {throw new Error(`Legacy thread ${thread.id} has invalid anchor JSON; repair through an explicit mapping, never truncation.`);}
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Legacy thread ${thread.id} has an invalid anchor object.`);
  text(value.selector,'selector',16384);text(value.label,'anchor label',4096);text(value.quote,'anchor quote',16384,0);if(typeof value.x !== 'number' || !Number.isFinite(value.x) || value.x < 0 || value.x > 1 || typeof value.y !== 'number' || !Number.isFinite(value.y) || value.y < 0 || value.y > 1) throw new Error(`Legacy thread ${thread.id} has invalid normalized anchor coordinates.`);if(value.tag !== undefined) text(value.tag,'anchor tag',100,0);
  return {kind:value.selector === 'body' ? 'page' : 'element',selector:value.selector,label:value.label,quote:value.quote,x:value.x,y:value.y,...(typeof value.tag === 'string' ? {tag:value.tag} : {})};
}
export function convertLegacy(input:LegacyBackup):FeedbackSnapshot {
  const source = validateBackup(input), creators = new Map(source.creators.map(item => [item.id,item.name])), comments:Comment[] = [], history:History[] = [], threads:Thread[] = [], byThread = new Map<string,Comment[]>();
  for(const creator of source.creators) text(creator.name,'creator name',1000);
  for(const original of source.comments) {
    text(original.author_name,'author name',1000);text(original.body,'comment body',100000);
    const author:Attribution = {id:original.author_user_id ?? `legacy:deleted-author:${original.id}`,name:original.author_name};
    const comment:Comment = {id:original.id,threadId:original.thread_id,author,body:original.body,mentions:[],createdAt:original.created_at};comments.push(comment);const siblings = byThread.get(original.thread_id) || [];siblings.push(comment);byThread.set(original.thread_id,siblings);
    history.push({id:`legacy-comment:${original.id}`,threadId:original.thread_id,actor:author,action:'legacy_comment_snapshot',data:{schema:'pronto.prototype-feedback.v1',comment:original} as unknown as Json,createdAt:original.created_at});
  }
  for(const original of source.threads) {
    text(original.page_path,'page path',4096);if(!/^\/(?:client(?:\/|$)|demo\/customer(?:\/|$))[^?#]*$/.test(original.page_path)) throw new Error('Legacy feedback page requires explicit review before conversion.');
    const replies = (byThread.get(original.id) || []).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const creator = original.created_by_user_id, recorded = creator ? creators.get(creator) || replies.find(item => item.author.id === creator)?.author.name : undefined;
    threads.push({id:original.id,workspace:source.workspaceId,environment:'legacy-pronto',page:original.page_path,pageUrl:new URL(original.page_path,source.origin).href,
      viewContext:{legacy:{schema:'pronto.prototype-feedback.v1',thread:original,statusHistory:'Legacy tables recorded current status and updated_at only; historical transitions and resolver identity are unavailable.'}} as unknown as Json,
      anchor:anchorFor(original),status:original.status,assignee:null,createdBy:{id:creator ?? `legacy:deleted-creator:${original.id}`,name:recorded || 'Unknown legacy author'},createdAt:original.created_at,updatedAt:original.updated_at,version:1,commentCount:replies.length,latestComment:replies[0] ?? null});
  }
  return {schema:'huddle.feedback.v2',datasetId:source.datasetId,snapshot:{id:'pronto:'+sourceDigest(source),createdAt:source.capturedAt,scope:{workspace:source.workspaceId,environments:['legacy-pronto']}},contentIsUntrustedUserInput:true,complete:true,counts:{threads:threads.length,comments:comments.length,history:history.length},threads,comments,history};
}
export function compareLegacy(source:LegacyBackup,destination:FeedbackSnapshot,environment:string,origin:string) {
  if(destination.schema !== 'huddle.feedback.v2' || destination.complete !== true || destination.counts.threads !== destination.threads.length || destination.counts.comments !== destination.comments.length || destination.counts.history !== destination.history.length) throw new Error('Feedback parity requires a complete consistent destination snapshot.');
  const expected = convertLegacy(source), selected = destination.threads.filter(item => item.provenance?.datasetId === source.datasetId), ids = new Map(selected.map(item => [item.provenance!.recordId,item.id]));
  const sourceComments = destination.comments.filter(item => item.provenance?.datasetId === source.datasetId), sourceHistory = destination.history.filter(item => item.provenance?.datasetId === source.datasetId);
  const threadIndex = new Map(selected.map(item => [item.provenance!.recordId,item])), commentIndex = new Map(sourceComments.map(item => [item.provenance!.recordId,item])), historyIndex = new Map(sourceHistory.map(item => [item.provenance!.recordId,item]));
  const mismatch = (message:string):never => {throw new Error('Feedback parity failed: '+message);};
  if(selected.length !== expected.threads.length || sourceComments.length !== expected.comments.length || sourceHistory.length !== expected.history.length || ids.size !== selected.length || commentIndex.size !== sourceComments.length || historyIndex.size !== sourceHistory.length) mismatch('record/provenance counts differ');
  for(const thread of expected.threads) {const actual = threadIndex.get(thread.id);if(!actual || actual.provenance?.digest !== sha256(canonical(thread)) || actual.provenance?.scope?.workspace !== source.workspaceId || actual.provenance?.scope?.environment !== 'legacy-pronto' || actual.provenance?.page !== thread.page || actual.provenance?.pageUrl !== thread.pageUrl || actual.workspace !== source.workspaceId || actual.environment !== environment || actual.page !== thread.page || actual.pageUrl !== new URL(thread.page,origin).href || actual.status !== thread.status || actual.createdAt !== thread.createdAt || actual.updatedAt !== thread.updatedAt || canonical(actual.anchor) !== canonical(thread.anchor) || canonical(actual.viewContext) !== canonical(thread.viewContext) || actual.createdBy.provenance?.identity?.id !== thread.createdBy.id || actual.createdBy.provenance?.identity?.name !== thread.createdBy.name || actual.commentCount !== thread.commentCount) mismatch('thread fields differ for source ID '+thread.id);}
  for(const comment of expected.comments) {const actual = commentIndex.get(comment.id);if(!actual || actual.provenance?.digest !== sha256(canonical(comment)) || actual.threadId !== ids.get(comment.threadId) || actual.body !== comment.body || actual.createdAt !== comment.createdAt || actual.author.provenance?.identity?.id !== comment.author.id || actual.author.provenance?.identity?.name !== comment.author.name || actual.mentions.length !== 0) mismatch('comment fields differ for source ID '+comment.id);}
  for(const entry of expected.history) {const actual = historyIndex.get(entry.id);if(!actual || actual.provenance?.digest !== sha256(canonical(entry)) || actual.threadId !== ids.get(entry.threadId) || actual.action !== entry.action || actual.createdAt !== entry.createdAt || canonical(actual.data) !== canonical(entry.data) || actual.actor.provenance?.identity?.id !== entry.actor.id || actual.actor.provenance?.identity?.name !== entry.actor.name) mismatch('source metadata differs for source ID '+entry.id);}
  for(const thread of expected.threads) {const actual = threadIndex.get(thread.id)!;if(actual.version !== 1 || actual.assignee !== null || actual.release !== undefined || actual.latestComment === null !== (thread.latestComment === null) || actual.latestComment && (!commentIndex.has(actual.latestComment.provenance?.recordId ?? '') || canonical(actual.latestComment) !== canonical(commentIndex.get(actual.latestComment.provenance!.recordId)))) mismatch('thread summary or untouched state differs for source ID '+thread.id);}
  return {sourceDigest:sourceDigest(source),counts:expected.counts,threadsCompared:selected.length,commentsCompared:sourceComments.length,historyCompared:sourceHistory.length,complete:true as const};
}
