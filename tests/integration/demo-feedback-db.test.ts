import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPool} from '@/lib/db';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
import {removePsCafeDemo,setupPsCafeDemo,PS_CAFE_DEMO_RESPONDER_ID} from '../../scripts/demo/ps-cafe-raffles-city';
import type {SessionUser} from '@/lib/auth';
const mock=vi.hoisted(()=>({user:vi.fn()}));
vi.mock('@/lib/auth',()=>({getSessionUser:mock.user}));
vi.mock('@/lib/customer-demo',()=>({assertDemoActor:vi.fn()}));
import {GET,POST} from '@/app/api/demo/feedback/route';
import {GET as EXPORT} from '@/app/api/demo/feedback/export/route';
const dbDescribe=process.env.PRONTO_RUN_DB_TESTS==='1'?describe:describe.skip;
const actor:SessionUser={userId:PS_CAFE_DEMO_RESPONDER_ID,role:'client',clientId:DEMO_CLIENT_ID,name:'QA reviewer',email:'qa@demo.test'};
const anchor={selector:'#brand-voice',label:'Brand voice',quote:'',x:0.5,y:0.5};
const post=(body:unknown)=>POST(new Request('http://localhost:3000/api/demo/feedback',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify(body)}));
const counts=async()=>(await getPool().query<{threads:number;comments:number}>(`select (select count(*)::int from demo_feedback_threads where client_id=$1) threads,(select count(*)::int from demo_feedback_comments where client_id=$1) comments`,[DEMO_CLIENT_ID])).rows[0];
dbDescribe('prototype feedback against an isolated database',()=>{
 beforeAll(async()=>{vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');vi.stubEnv('PRONTO_HUDDLE_ENABLED','1');await removePsCafeDemo();await setupPsCafeDemo();});
 beforeEach(async()=>{vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',PS_CAFE_DEMO_RESPONDER_ID);mock.user.mockResolvedValue(actor);await getPool().query("insert into prototype_feedback_state(client_id,mode) values($1,'legacy') on conflict(client_id) do update set mode='legacy'",[DEMO_CLIENT_ID]);await getPool().query('delete from demo_feedback_threads where client_id=$1',[DEMO_CLIENT_ID]);});
 afterAll(async()=>{await removePsCafeDemo();vi.unstubAllEnvs();await getPool().end();});
 it('does not create a second thread or comment when a committed save is retried',async()=>{
  const payload={action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Please clarify.'};
  const first=await (await post(payload)).json();const retry=await post(payload);
  expect(retry.status).toBe(200);expect(await retry.json()).toEqual({id:first.id,replayed:true});expect(await counts()).toEqual({threads:1,comments:1});
 });
 it('collapses simultaneous submissions of the same request into one record',async()=>{
  const payload={action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Double click.'};
  const responses=await Promise.all([post(payload),post(payload),post(payload)]);
  expect(responses.map(r=>r.status)).toEqual([200,200,200]);expect(new Set((await Promise.all(responses.map(r=>r.json()))).map(b=>b.id)).size).toBe(1);expect(await counts()).toEqual({threads:1,comments:1});
 });
 it('deduplicates replies, keeps distinct requests and does not bump the thread on a replay',async()=>{
  const {id}=await (await post({action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Start.'})).json();
  const reply={action:'reply',requestId:randomUUID(),threadId:id,body:'Follow-up.'};
  await post(reply);const before=(await getPool().query('select updated_at from demo_feedback_threads where id=$1',[id])).rows[0].updated_at;
  expect((await post(reply)).status).toBe(200);
  expect((await getPool().query('select updated_at from demo_feedback_threads where id=$1',[id])).rows[0].updated_at).toEqual(before);
  await post({...reply,requestId:randomUUID(),body:'A genuinely second reply.'});expect(await counts()).toEqual({threads:1,comments:3});
 });
 it('does not let another reviewer replay a request ID to read a thread',async()=>{
  const requestId=randomUUID();await post({action:'create',requestId,path:'/client/knowledge',anchor,body:'Mine.'});
  const other=(await getPool().query(`insert into users(client_id,email,name,role,password_hash) values($1,$2,'Other reviewer','client','x') returning id`,[DEMO_CLIENT_ID,`other-${randomUUID()}@demo.test`])).rows[0];
  vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',`${PS_CAFE_DEMO_RESPONDER_ID},${other.id}`);mock.user.mockResolvedValue({...actor,userId:other.id});
  expect((await post({action:'create',requestId,path:'/client/knowledge',anchor,body:'Theirs.'})).status).toBe(409);expect(await counts()).toEqual({threads:1,comments:1});
 });
 it('exports every thread and comment in one download, while the paged export stays bounded',async()=>{
  const pool=getPool();
  for(let i=0;i<30;i+=1){const t=(await pool.query(`insert into demo_feedback_threads(client_id,page_path,anchor,created_at) values($1,'/client/knowledge',$2,now()-($3||' seconds')::interval) returning id`,[DEMO_CLIENT_ID,anchor,String(i)])).rows[0];
   await pool.query(`insert into demo_feedback_comments(client_id,thread_id,author_name,body) select $1,$2,'QA','c'||g from generate_series(1,$3::int) g`,[DEMO_CLIENT_ID,t.id,i===0?120:1]);}
  const paged=await (await EXPORT(new Request('http://localhost:3000/api/demo/feedback/export?status=all'))).json();
  expect(paged.threads).toHaveLength(25);expect(paged.pagination.hasMore).toBe(true);
  const full=await (await EXPORT(new Request('http://localhost:3000/api/demo/feedback/export?status=all&complete=1'))).json();
  expect(full).toMatchObject({complete:true,pagination:{hasMore:false}});expect(full.threads).toHaveLength(30);
  expect(new Set(full.threads.map((t:{id:string})=>t.id)).size).toBe(30);
  expect(full.threads.reduce((n:number,t:{comments:unknown[]})=>n+t.comments.length,0)).toBe(149);expect(full.threads.some((t:{commentsTruncated:boolean})=>t.commentsTruncated)).toBe(false);
  expect(paged.threads.find((t:{commentCount:number})=>t.commentCount===120)).toMatchObject({commentsTruncated:true});
 });
 it('tells the overlay when the page list omits comments or threads',async()=>{
  const pool=getPool();
  for(let i=0;i<101;i+=1){const t=(await pool.query(`insert into demo_feedback_threads(client_id,page_path,anchor,updated_at) values($1,'/client/inbox',$2,now()-($3||' seconds')::interval) returning id`,[DEMO_CLIENT_ID,anchor,String(i)])).rows[0];
   await pool.query(`insert into demo_feedback_comments(client_id,thread_id,author_name,body,created_at) select $1,$2,'QA','c'||g,now()+g*interval '1 second' from generate_series(1,$3::int) g`,[DEMO_CLIENT_ID,t.id,i===0?60:1]);}
  const body=await (await GET(new Request('http://localhost:3000/api/demo/feedback?path=/client/inbox'))).json();
  expect(body.threads).toHaveLength(100);expect(body.hasMoreThreads).toBe(true);
  expect(body.threads[0]).toMatchObject({comment_count:60});expect(body.threads[0].comments).toHaveLength(50);expect(body.threads[0].comments.at(-1).body).toBe('c60');
  expect(body.threads[1]).toMatchObject({comment_count:1});
 });
 it('lets a reviewer see every reviewer\'s threads on every page, or narrow to one page',async()=>{
  const other=(await getPool().query(`insert into users(client_id,email,name,role,password_hash) values($1,$2,'Keith','client','x') returning id`,[DEMO_CLIENT_ID,`keith-${randomUUID()}@demo.test`])).rows[0];
  await post({action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Mine on knowledge.'});
  vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',`${PS_CAFE_DEMO_RESPONDER_ID},${other.id}`);mock.user.mockResolvedValue({...actor,userId:other.id,name:'Keith'});
  await post({action:'create',requestId:randomUUID(),path:'/client/inbox',anchor,body:'Keith on inbox.'});
  mock.user.mockResolvedValue(actor);
  const all=await (await GET(new Request('http://localhost:3000/api/demo/feedback'))).json();
  expect(all.viewerId).toBe(actor.userId);expect(all.threads.map((t:{page_path:string})=>t.page_path).sort()).toEqual(['/client/inbox','/client/knowledge']);
  expect(all.threads.find((t:{page_path:string})=>t.page_path==='/client/inbox').comments[0]).toMatchObject({author_name:'Keith',author_user_id:other.id});
  const one=await (await GET(new Request('http://localhost:3000/api/demo/feedback?path=/client/inbox'))).json();expect(one.threads).toHaveLength(1);
  expect((await GET(new Request('http://localhost:3000/api/demo/feedback?path=/api/operator'))).status).toBe(400);
 });
 it('rejects an export cursor that does not exist',async()=>{
  expect((await EXPORT(new Request(`http://localhost:3000/api/demo/feedback/export?status=all&cursor=${randomUUID()}`))).status).toBe(400);
 });
 it('lists saved threads for the page',async()=>{
  await post({action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Visible.'});
  const body=await (await GET(new Request('http://localhost:3000/api/demo/feedback?path=/client/knowledge'))).json();
  expect(body.threads).toHaveLength(1);expect(body.threads[0].comments[0].body).toBe('Visible.');
 });
});
