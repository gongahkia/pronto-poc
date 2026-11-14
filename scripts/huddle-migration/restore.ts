import {disposablePostgres} from '../huddle-fixtures/postgres';
import {readLegacy,sourceDigest,validateBackup,type LegacyBackup} from './legacy';
export async function restoreFeedbackBackup(input:LegacyBackup) {
  const source = validateBackup(input), fixture = await disposablePostgres();let restored = false;
  try {
    await fixture.verify();const db = await fixture.pool.connect();
    try {
      await db.query('begin');
      // recovery contains feedback and display-name snapshots only, never login/access grants.
      await db.query(`create table users(id uuid primary key,name text not null);
        create table demo_feedback_threads(id uuid primary key,client_id uuid not null,page_path text not null,anchor jsonb not null,status text not null check(status in ('open','resolved')),created_by_user_id uuid,created_at timestamptz not null,updated_at timestamptz not null);
        create table demo_feedback_comments(id uuid primary key,client_id uuid not null,thread_id uuid not null references demo_feedback_threads(id),author_user_id uuid,author_name text not null,body text not null check(char_length(body) between 1 and 3000),request_id uuid,created_at timestamptz not null);`);
      for(const user of source.creators) await db.query('insert into users(id,name) values($1,$2)',[user.id,user.name]);
      for(const thread of source.threads) await db.query('insert into demo_feedback_threads(id,client_id,page_path,anchor,status,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[thread.id,thread.client_id,thread.page_path,thread.anchor_json,thread.status,thread.created_by_user_id,thread.created_at,thread.updated_at]);
      for(const comment of source.comments) await db.query('insert into demo_feedback_comments(id,client_id,thread_id,author_user_id,author_name,body,request_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[comment.id,comment.client_id,comment.thread_id,comment.author_user_id,comment.author_name,comment.body,comment.request_id,comment.created_at]);
      await db.query('commit');
    } catch(error) {await db.query('rollback').catch(() => {});throw error;} finally {db.release();}
    const recovered = await readLegacy(fixture.pool,{workspaceId:source.workspaceId,datasetId:source.datasetId,origin:source.origin});
    if(sourceDigest(recovered) !== sourceDigest(source)) throw new Error('Feedback backup recovery differs from the complete source snapshot.');restored = true;
  } finally {await fixture.close();}
  return {schema:'pronto.feedback.backup-restore.v1' as const,complete:restored,sourceDigest:sourceDigest(source),sourceDatasetId:source.datasetId,workspaceId:source.workspaceId,counts:source.counts,restoredAt:new Date().toISOString(),postgres:fixture.version,node:process.version,cleanup:true as const,scope:'Feedback tables and recorded creator names only; this is not an application-account or whole-database restore.'};
}
