import {getPool} from '../../src/lib/db';
import {verifyTestDatabase} from '../test-db-safety';
import {setupPsCafeDemo,PS_CAFE_DEMO_CLIENT_ID,PS_CAFE_DEMO_APPROVER_ID,PS_CAFE_DEMO_RESPONDER_ID} from '../demo/ps-cafe-raffles-city';
import {migrationContext} from '../huddle-migration/context';
import {activate,backup,execute,pause,prepare,preview,verify} from '../huddle-migration/operations';
import {restoreFeedbackBackup} from '../huddle-migration/restore';
import {sha256} from '../huddle-migration/legacy';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
await verifyTestDatabase();const db = getPool();
try {
  const row = (await db.query("select current_setting('pronto.fixture_nonce',true) nonce")).rows[0];if(!process.env.PRONTO_HUDDLE_FIXTURE_NONCE || row.nonce !== process.env.PRONTO_HUDDLE_FIXTURE_NONCE || process.env.PRONTO_HUDDLE_E2E !== '1') throw new Error('Browser seeding requires this task-owned fixture.');
  await setupPsCafeDemo();const legacy = (await db.query('select count(*)::int count from demo_feedback_threads where client_id=$1',[PS_CAFE_DEMO_CLIENT_ID])).rows[0];if(legacy.count !== 0) throw new Error('This owned browser fixture requires a fresh source, never existing feedback.');
  for(const permission of ['conversation.respond','conversation.release']) await db.query('insert into staff_permission_grants(client_id,user_id,permission) values($1,$2,$3) on conflict do nothing',[PS_CAFE_DEMO_CLIENT_ID,PS_CAFE_DEMO_APPROVER_ID,permission]);
  await db.query("insert into prototype_feedback_state(client_id,mode) values($1,'legacy') on conflict(client_id) do update set mode='legacy'",[PS_CAFE_DEMO_CLIENT_ID]);
  const threadId = '00000000-0000-4000-8000-00000000f801';await db.query("insert into demo_feedback_threads(id,client_id,page_path,anchor,status,created_by_user_id,created_at,updated_at) values($1,$2,'/client/inbox',$3,'open',null,'2026-01-01T00:00:00.123456Z','2026-01-02T00:00:00.987654Z')",[threadId,PS_CAFE_DEMO_CLIENT_ID,{selector:'h1',label:'Legacy Inbox',quote:'Inbox',x:0.5,y:0.5,feedbackId:'preserved-legacy',opaque:{kept:true}}]);
  for(const [index,body] of ['Preserved legacy page observation 🌍','Preserved historical reply'].entries()) await db.query("insert into demo_feedback_comments(id,client_id,thread_id,author_user_id,author_name,body,request_id,created_at) values($1,$2,$3,null,'Historical visitor',$4,$5,$6)",[randomUUID(),PS_CAFE_DEMO_CLIENT_ID,threadId,body,randomUUID(),`2026-01-01T01:00:0${index}.123456Z`]);
  const contextInput = {databaseId:process.env.PRONTO_HUDDLE_FIXTURE_NONCE!,actorId:PS_CAFE_DEMO_RESPONDER_ID}, identified = await migrationContext(contextInput), fingerprint = identified.fingerprint;await identified.close();const ctx = await migrationContext({...contextInput,fingerprint});
  try {
    await pause(ctx);const source = await backup(ctx), bytes = Buffer.from(JSON.stringify(source)+'\n'), recovered = {...await restoreFeedbackBackup(source),backupSha256:sha256(bytes)};
    const output = resolve('output/huddle-v2/browser-migrations',randomUUID());await mkdir(output,{recursive:true,mode:0o700});await writeFile(output+'/source.json',bytes,{mode:0o600});await writeFile(output+'/restore.json',JSON.stringify(recovered)+'\n',{mode:0o600});
    await prepare(ctx,bytes,recovered);const plan = await preview(ctx), result = await execute(ctx,{previewId:plan.id,digest:plan.digest,idempotencyKey:plan.idempotencyKey,maxBatches:10});if(result.state !== 'complete') throw new Error('Browser migration fixture did not finish.');const parity = await verify(ctx);await activate(ctx);await writeFile(output+'/parity.json',JSON.stringify(parity)+'\n',{mode:0o600});
  } finally {await ctx.close();}
  console.log('Task-owned source backed up, restored, migrated, compared and activated; no model or worker started.');
} finally {await db.end();}
