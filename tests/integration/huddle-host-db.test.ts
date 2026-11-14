// @vitest-environment node
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPool} from '@/lib/db';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
import type {SessionUser} from '@/lib/auth';
import {setupPsCafeDemo,removePsCafeDemo,PS_CAFE_DEMO_RESPONDER_ID,PS_CAFE_DEMO_APPROVER_ID,PS_CAFE_DEMO_ORDINARY_STAFF_ID} from '../../scripts/demo/ps-cafe-raffles-city';
import {verifyTestDatabase} from '../../scripts/test-db-safety';
const mocked = vi.hoisted(() => ({user:vi.fn()}));
vi.mock('@/lib/auth',() => ({getSessionUser:mocked.user,getSessionUserFromToken:mocked.user}));
import {handleFeedback} from '@/lib/feedback/huddle';
import {POST as legacyPost,GET as legacyGet} from '@/app/api/demo/feedback/route';
import {GET as legacyExport} from '@/app/api/demo/feedback/export/route';
import {feedbackLock} from '@/lib/feedback/state';
const suite = process.env.PRONTO_RUN_DB_TESTS === '1' && process.env.PRONTO_RUN_HUDDLE_DB_TESTS === '1' ? describe : describe.skip;
const alex:SessionUser = {userId:PS_CAFE_DEMO_RESPONDER_ID,email:'responder@ps-cafe-demo.test',name:'Demo responder',role:'client',clientId:DEMO_CLIENT_ID}, morgan:SessionUser = {userId:PS_CAFE_DEMO_APPROVER_ID,email:'approver@ps-cafe-demo.test',name:'Demo knowledge approver',role:'client',clientId:DEMO_CLIENT_ID};
let environment = '';
const scope = () => ({workspace:DEMO_CLIENT_ID,environment});
const query = () => new URLSearchParams(scope()).toString();
const request = (path:string,body?:unknown,method = body === undefined ? 'GET' : 'POST') => handleFeedback(new Request(`http://localhost:3000/api/demo/feedback/v2${path}${path === '/exports' ? '' : (path.includes('?') ? '&' : '?')+query()}`,{method,headers:{origin:'http://localhost:3000','content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)}));
const create = (extra:Record<string,unknown> = {}) => ({idempotencyKey:randomUUID(),page:'/client/inbox',pageUrl:'http://localhost:3000/client/inbox',anchor:{kind:'page',selector:'body',label:'Pronto fixture',quote:'',x:0,y:0},body:'Shared review ✓ <script>',...extra});
const mode = async (value:string) => {await getPool().query("insert into prototype_feedback_state(client_id,mode) values($1,$2) on conflict(client_id) do update set mode=excluded.mode",[DEMO_CLIENT_ID,value]);};
const legacy = () => legacyPost(new Request('http://localhost:3000/api/demo/feedback',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify({action:'create',requestId:randomUUID(),path:'/client/inbox',anchor:{selector:'body',label:'Legacy source',quote:'',x:0,y:0},body:'Original source'})}));
suite('Pronto host integration on an explicitly owned real PostgreSQL fixture',() => {
  beforeAll(async () => {
    await verifyTestDatabase();const row = (await getPool().query("select current_setting('pronto.fixture_nonce',true) nonce")).rows[0];if(!process.env.PRONTO_HUDDLE_FIXTURE_NONCE || row.nonce !== process.env.PRONTO_HUDDLE_FIXTURE_NONCE) throw new Error('Requires the task-owned Huddle verification database.');
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');vi.stubEnv('PRONTO_HUDDLE_ENABLED','1');vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',`${alex.userId},${morgan.userId}`);await removePsCafeDemo();await setupPsCafeDemo();
  });
  beforeEach(async () => {environment = 'db'+randomUUID().replace(/-/g,'');vi.stubEnv('PRONTO_HUDDLE_ENVIRONMENT',environment);mocked.user.mockResolvedValue(alex);await mode('active');});
  afterAll(async () => {await mode('legacy');await removePsCafeDemo();vi.unstubAllEnvs();await getPool().end();});
  it('denies absent, guest and non-invited sessions on both APIs before exposing feedback',async () => {
    for(const actor of [null,{...alex,email:'guest@guest.invalid'},{...alex,userId:PS_CAFE_DEMO_ORDINARY_STAFF_ID}]) {mocked.user.mockResolvedValue(actor);const status = actor ? 403 : 401;expect((await request('/session')).status).toBe(status);expect((await request('/threads',create())).status).toBe(status);expect((await legacyGet(new Request('http://localhost:3000/api/demo/feedback'))).status).toBe(status);expect((await legacyExport(new Request('http://localhost:3000/api/demo/feedback/export?complete=1'))).status).toBe(status);expect((await legacy()).status).toBe(status);}
  });
  it('derives authors from the host, preserves retries, handles conflicts and uses approved members only',async () => {
    const payload = create(), first = await request('/threads',payload);expect(first.status).toBe(201);const saved = await first.json();expect(saved.thread.createdBy).toMatchObject({id:alex.userId,name:alex.name});expect((await (await request('/threads',payload)).json()).thread.id).toBe(saved.thread.id);expect((await request('/threads',{...payload,body:'Changed retry'})).status).toBe(409);
    mocked.user.mockResolvedValue(morgan);const replied = await request(`/threads/${saved.thread.id}/replies`,{idempotencyKey:randomUUID(),body:'Morgan reply',mentions:[alex.userId]});expect(replied.status).toBe(200);const result = await replied.json();expect(result.comments.items.at(-1).author.id).toBe(morgan.userId);expect(result.comments.items.at(-1).mentions[0].id).toBe(alex.userId);
    expect((await request(`/threads/${saved.thread.id}`,{idempotencyKey:randomUUID(),expectedVersion:result.thread.version,status:'resolved'},'PATCH')).status).toBe(200);expect((await request(`/threads/${saved.thread.id}`,{idempotencyKey:randomUUID(),expectedVersion:result.thread.version,status:'open'},'PATCH')).status).toBe(409);
    const members = await (await request('/directory')).json();expect(members.items).toHaveLength(2);expect(Object.keys(members.items[0]).sort()).toEqual(['id','name']);expect(JSON.stringify(members)).not.toContain('@ps-cafe');expect((await request('/threads',create({author:{id:alex.userId,name:'Forged'}}))).status).toBe(400);
  });
  it('enforces the maintenance, legacy, active and read-only writer boundary without dual writes',async () => {
    await mode('maintenance');expect((await request('/threads',create())).status).toBe(503);expect((await legacy()).status).toBe(503);
    await mode('legacy');expect((await legacy()).status).toBe(200);expect((await request('/threads',create())).status).toBe(503);
    await mode('active');expect((await legacy()).status).toBe(503);expect((await request('/threads',create())).status).toBe(201);
    await mode('readonly');expect((await request('/threads',create())).status).toBe(503);expect((await legacy()).status).toBe(503);expect((await request('/threads')).status).toBe(200);const exported = await request('/exports',{scope:{workspace:DEMO_CLIENT_ID,environments:[environment]},format:'json'});expect(exported.status).toBe(200);expect((await exported.json()).complete).toBe(true);
  });
  it('blocks a new writer behind the real migration lock and accepts only its deliberate retry',async () => {
    const db = await getPool().connect(), payload = create();try {await db.query('select pg_advisory_lock(hashtextextended($1,0))',[feedbackLock]);expect((await request('/threads',payload)).status).toBe(504);} finally {await db.query('select pg_advisory_unlock(hashtextextended($1,0))',[feedbackLock]);db.release();}const result = await request('/threads',payload);expect(result.status).toBe(201);expect((await (await request('/threads')).json()).items).toHaveLength(1);
  },10000);
  it('pauses the SQL issued by older deployments and rechecks the mode after waiting for the migration lock',async () => {
    const admin = await getPool().connect(), writer = await getPool().connect(), id = randomUUID();await mode('legacy');
    try {
      await admin.query('select pg_advisory_lock(hashtextextended($1,0))',[feedbackLock]);await writer.query("set application_name='huddle_legacy_pause_probe'");
      const pending = writer.query("insert into demo_feedback_threads(id,client_id,page_path,anchor,created_by_user_id) values($1,$2,'/client/inbox',$3,$4)",[id,DEMO_CLIENT_ID,{selector:'body',label:'Original writer',quote:'',x:0,y:0},alex.userId]).then(() => null,error => error);
      await vi.waitFor(async () => {expect((await getPool().query("select wait_event from pg_stat_activity where application_name='huddle_legacy_pause_probe'")).rows.some(row => row.wait_event === 'advisory')).toBe(true);});
      await mode('maintenance');await admin.query('select pg_advisory_unlock(hashtextextended($1,0))',[feedbackLock]);expect(await pending).toMatchObject({code:'55000'});expect((await getPool().query('select id from demo_feedback_threads where id=$1',[id])).rows).toHaveLength(0);
      const outside = randomUUID();await writer.query("insert into demo_feedback_threads(id,client_id,page_path,anchor) values($1,'00000000-0000-4000-8000-000000000001','/client/inbox',$2)",[outside,{selector:'body',label:'Other workspace',quote:'',x:0,y:0}]);await writer.query('delete from demo_feedback_threads where id=$1',[outside]);
    } finally {await admin.query('select pg_advisory_unlock_all()');await writer.query('reset application_name');admin.release();writer.release();}
  },10000);
  it('rejects guessed scope, foreign origins, cross-workspace reads and revoked access',async () => {
    const saved = await (await request('/threads',create())).json();const foreign = new Request(`http://localhost:3000/api/demo/feedback/v2/threads/${saved.thread.id}?workspace=other&environment=${environment}`);expect((await handleFeedback(foreign)).status).toBe(403);
    expect((await handleFeedback(new Request(`http://localhost:3000/api/demo/feedback/v2/threads?${query()}`,{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify(create())}))).status).toBe(403);
    mocked.user.mockResolvedValue(null);expect((await request(`/threads/${saved.thread.id}`)).status).toBe(401);expect((await request('/exports',{scope:{workspace:DEMO_CLIENT_ID,environments:[environment]},format:'json'})).status).toBe(401);
  });
});
