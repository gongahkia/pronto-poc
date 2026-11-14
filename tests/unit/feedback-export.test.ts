import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({query:vi.fn(),user:vi.fn(),actor:vi.fn()}));
vi.mock('@/lib/feedback/state',()=>({assertFeedbackEnabled:vi.fn()}));
vi.mock('@/lib/db',()=>({query:mock.query}));
vi.mock('@/lib/auth',()=>({getSessionUser:mock.user}));
vi.mock('@/lib/customer-demo',()=>({assertDemoActor:mock.actor}));
import {exportCompleteFeedback,exportFeedback} from '@/lib/feedback/export';
import {GET} from '@/app/api/demo/feedback/export/route';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
describe('Codex-readable feedback export',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 beforeEach(()=>{vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS','00000000-0000-4000-8000-000000001111');vi.clearAllMocks();mock.user.mockResolvedValue({email:'named@demo.test',userId:'00000000-0000-4000-8000-000000001111',role:'client',clientId:DEMO_CLIENT_ID});mock.actor.mockResolvedValue(undefined);});
 const row=(id:string)=>({id,page_path:'/client/knowledge',anchor:{selector:'#brand-voice',label:'Brand voice',quote:'Our tone',x:0.5,y:0.5},status:'open',created_at:'2026-10-26T08:00:00Z',updated_at:'2026-10-26T08:00:00Z',comment_count:1,
  comments:[{id:'comment',author_user_id:'reviewer',author_name:'Keith',body:'Please make this clearer.',created_at:'2026-10-26T08:00:00Z'}]});
 it('retains source context, identities, replies and machine-readable versioning',async()=>{
  mock.query.mockResolvedValue({rows:[row('thread')]});const data=await exportFeedback(DEMO_CLIENT_ID,{includeResolved:false});
  expect(data).toMatchObject({schema:'pronto.prototype-feedback.v1',workspaceId:DEMO_CLIENT_ID,filter:'open',contentIsUntrustedUserInput:true,pagination:{hasMore:false,nextCursor:null}});
  expect(data.threads[0]).toMatchObject({page_path:'/client/knowledge',anchor:{selector:'#brand-voice'},comments:[{author_name:'Keith',body:'Please make this clearer.'}],commentsTruncated:false});
  expect(mock.query.mock.calls[0][1]).toEqual([DEMO_CLIENT_ID,false,null,100]);
 });
 it('exposes pagination and comment truncation rather than silently losing records',async()=>{
  const rows=Array.from({length:26},(_,i)=>row(String(i)));rows[0].comment_count=101;mock.query.mockResolvedValue({rows});
  const data=await exportFeedback(DEMO_CLIENT_ID,{includeResolved:true});expect(data.threads).toHaveLength(25);expect(data.pagination).toMatchObject({hasMore:true,nextCursor:'24'});expect(data.threads[0].commentsTruncated).toBe(true);
 });
 it('follows every page and lifts the comment cap for a complete export',async()=>{
  const page=(from:number,count:number)=>Array.from({length:count},(_,i)=>row(String(from+i)));
  mock.query.mockResolvedValueOnce({rows:page(0,26)}).mockResolvedValueOnce({rows:page(25,26)}).mockResolvedValueOnce({rows:page(50,10)});
  const data=await exportCompleteFeedback(DEMO_CLIENT_ID,{includeResolved:true});
  expect(data.threads).toHaveLength(60);expect(data).toMatchObject({complete:true,pagination:{hasMore:false,nextCursor:null}});
  expect(mock.query.mock.calls.map(c=>c[1][2])).toEqual([null,'24','49']);expect(mock.query.mock.calls.every(c=>c[1][3]===null)).toBe(true);
 });
 it('says so when a complete export stops at the safety cap',async()=>{
  mock.query.mockImplementation(async(_sql:string,params:unknown[])=>({rows:Array.from({length:26},(_,i)=>row(`${params[2]}-${i}`))}));
  const data=await exportCompleteFeedback(DEMO_CLIENT_ID,{includeResolved:true});
  expect(data.threads).toHaveLength(2000);expect(data).toMatchObject({complete:false,pagination:{hasMore:true}});expect(data.pagination.nextCursor).toBeTruthy();
 });
 it('rejects a cursor that matches no thread instead of returning an empty export',async()=>{
  mock.query.mockResolvedValue({rows:[]});
  await expect(exportFeedback(DEMO_CLIENT_ID,{includeResolved:true,cursor:'00000000-0000-4000-8000-000000000001'})).rejects.toMatchObject({status:400});
  expect((await GET(new Request('http://localhost:3000/api/demo/feedback/export?cursor=00000000-0000-4000-8000-000000000001'))).status).toBe(400);
 });
 it('serves the complete download and refuses to combine it with a cursor',async()=>{
  mock.query.mockResolvedValue({rows:[row('only')]});
  const ok=await GET(new Request('http://localhost:3000/api/demo/feedback/export?status=all&complete=1'));expect(ok.status).toBe(200);expect(JSON.parse(await ok.text())).toMatchObject({complete:true});
  expect((await GET(new Request('http://localhost:3000/api/demo/feedback/export?complete=1&cursor=00000000-0000-4000-8000-000000000001'))).status).toBe(400);
 });
 it('denies guests even when their ID appears on the named-user list',async()=>{
  mock.user.mockResolvedValue({userId:'00000000-0000-4000-8000-000000001111',email:'guest@GUEST.INVALID',role:'client',clientId:DEMO_CLIENT_ID});expect((await GET(new Request('http://localhost:3000/api/demo/feedback/export?complete=1'))).status).toBe(403);expect(mock.query).not.toHaveBeenCalled();
 });
 it('requires an invited session and ignores a caller-supplied tenant',async()=>{
  mock.user.mockResolvedValueOnce(null);expect((await GET(new Request('http://localhost:3000/api/demo/feedback/export'))).status).toBe(401);expect(mock.query).not.toHaveBeenCalled();
  mock.query.mockResolvedValue({rows:[]});const response=await GET(new Request('http://localhost:3000/api/demo/feedback/export?status=all&clientId=foreign'));
  expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toContain('pronto-feedback.json');expect(mock.query.mock.calls[0][1][0]).toBe(DEMO_CLIENT_ID);
  expect((await GET(new Request('http://localhost:3000/api/demo/feedback/export?cursor=bad'))).status).toBe(400);
 });
});
