import {getPool} from '../../src/lib/db';
import {verifyTestDatabase} from '../test-db-safety';
import {setupPsCafeDemo,PS_CAFE_DEMO_CLIENT_ID,PS_CAFE_DEMO_APPROVER_ID} from '../demo/ps-cafe-raffles-city';
await verifyTestDatabase();const db = getPool();
try {
  const row = (await db.query("select current_setting('pronto.fixture_nonce',true) nonce")).rows[0];if(!process.env.PRONTO_HUDDLE_FIXTURE_NONCE || row.nonce !== process.env.PRONTO_HUDDLE_FIXTURE_NONCE || process.env.PRONTO_HUDDLE_E2E !== '1') throw new Error('Browser seeding requires this task-owned fixture.');
  await setupPsCafeDemo();const legacy = (await db.query('select count(*)::int count from demo_feedback_threads where client_id=$1',[PS_CAFE_DEMO_CLIENT_ID])).rows[0];if(legacy.count !== 0) throw new Error('This empty-install browser fixture cannot bypass migration of existing feedback.');
  for(const permission of ['conversation.respond','conversation.release']) await db.query('insert into staff_permission_grants(client_id,user_id,permission) values($1,$2,$3) on conflict do nothing',[PS_CAFE_DEMO_CLIENT_ID,PS_CAFE_DEMO_APPROVER_ID,permission]);
  await db.query("insert into prototype_feedback_state(client_id,mode) values($1,'active') on conflict(client_id) do update set mode='active'",[PS_CAFE_DEMO_CLIENT_ID]);
  console.log('Task-owned empty-source browser fixture prepared; no model or worker started.');
} finally {await db.end();}
