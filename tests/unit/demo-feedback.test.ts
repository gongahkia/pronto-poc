import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {feedbackMutation,feedbackPath} from '@/lib/feedback/schema';
const mock=vi.hoisted(()=>({user:vi.fn(),assertActor:vi.fn(),query:vi.fn()}));
vi.mock('@/lib/feedback/state',()=>({assertFeedbackEnabled:vi.fn(),lockFeedbackTransaction:vi.fn()}));
vi.mock('@/lib/auth',()=>({getSessionUser:mock.user}));
vi.mock('@/lib/customer-demo',()=>({assertDemoActor:mock.assertActor}));
vi.mock('@/lib/db',()=>({query:mock.query,transaction:async(run:(db:{query:typeof mock.query})=>Promise<unknown>)=>run({query:mock.query})}));
import {GET,POST} from '@/app/api/demo/feedback/route';
const id='00000000-0000-4000-8000-000000001111';
const requestId='00000000-0000-4000-8000-000000002222';
const anchor={selector:'#brand-voice',label:'Brand voice',quote:'Our tone',x:0.5,y:0.2};
const request=(body:unknown,origin='http://localhost:3000')=>new Request('http://localhost:3000/api/demo/feedback',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
describe('private prototype feedback',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 beforeEach(()=>{vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',id);vi.clearAllMocks();mock.user.mockResolvedValue({email:'named@demo.test',userId:id,clientId:'00000000-0000-4000-8000-00000000a101',name:'Demo reviewer',role:'client'});mock.assertActor.mockResolvedValue(undefined);mock.query.mockResolvedValue({rows:[{id}],rowCount:1});});
 it('only accepts bounded comments and anchors for prototype pages',()=>{
  expect(feedbackMutation.safeParse({action:'create',requestId,path:'/client/knowledge',anchor,body:'Use more whitespace.'}).success).toBe(true);
  expect(feedbackPath.safeParse('/api/operator/inspect').success).toBe(false);
  expect(feedbackMutation.safeParse({action:'create',requestId,path:'/client/inbox',anchor:{...anchor,x:2},body:'Test'}).success).toBe(false);
  expect(feedbackMutation.safeParse({action:'reply',requestId,threadId:id,body:'x'.repeat(3001)}).success).toBe(false);
 });
 it('requires an authenticated, authorised demo actor before exposing comments',async()=>{
  mock.user.mockResolvedValue(null);expect((await GET(new Request('http://localhost:3000/api/demo/feedback?path=/client/knowledge'))).status).toBe(401);expect(mock.query).not.toHaveBeenCalled();
 });
 it('rejects guest and non-invited sessions before reading or mutating feedback',async()=>{
  for(const user of [{userId:id,email:'guest@guest.invalid'},{userId:requestId,email:'customer@demo.test'}]) {mock.user.mockResolvedValue({...user,name:'Caller',role:'client',clientId:'00000000-0000-4000-8000-00000000a101'});expect((await GET(new Request('http://localhost:3000/api/demo/feedback'))).status).toBe(403);expect((await POST(request({action:'reply',requestId,threadId:id,body:'Denied'}))).status).toBe(403);}
  expect(mock.query).not.toHaveBeenCalled();expect(mock.assertActor).not.toHaveBeenCalled();
 });
 it('stores thread and author identity from the authenticated demo workspace',async()=>{
  expect((await POST(request({action:'create',requestId,path:'/client/knowledge',anchor,body:'Review this card.'}))).status).toBe(200);
  expect(mock.query.mock.calls[0][1]).toEqual(['00000000-0000-4000-8000-00000000a101','/client/knowledge',anchor,id]);
  expect(mock.query.mock.calls[1][1]).toEqual(['00000000-0000-4000-8000-00000000a101',id,id,'Demo reviewer','Review this card.',requestId]);
 });
 it('rejects foreign origins, author overrides and inaccessible thread IDs',async()=>{
  expect((await POST(request({action:'reply',requestId,threadId:id,body:'Test'},'https://foreign.example'))).status).toBe(403);
  expect((await POST(request({action:'reply',requestId,threadId:id,body:'Test',authorName:'Another person'}))).status).toBe(400);
  mock.query.mockResolvedValueOnce({rows:[]});expect((await POST(request({action:'reply',requestId,threadId:id,body:'Test'}))).status).toBe(404);
 });
 it('requires a request ID for saves that add comments',()=>{
  expect(feedbackMutation.safeParse({action:'create',path:'/client/knowledge',anchor,body:'No ID'}).success).toBe(false);
  expect(feedbackMutation.safeParse({action:'reply',requestId:'not-a-uuid',threadId:id,body:'Bad ID'}).success).toBe(false);
  expect(feedbackMutation.safeParse({action:'status',threadId:id,status:'resolved'}).success).toBe(true);
 });
 it('returns the original thread when a lost-response save is retried instead of duplicating it',async()=>{
  const original='00000000-0000-4000-8000-000000003333';
  mock.query.mockResolvedValueOnce({rows:[{id}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{thread_id:original}]});
  const response=await POST(request({action:'create',requestId,path:'/client/knowledge',anchor,body:'Retry me.'}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({id:original,replayed:true});
  expect(mock.query.mock.calls.filter(([sql])=>/update demo_feedback_threads/.test(sql))).toHaveLength(0);
  expect(mock.query.mock.calls[2][1]).toEqual(['00000000-0000-4000-8000-00000000a101',requestId,id]);
 });
 it('does not leak another reviewer\'s thread through a reused request ID',async()=>{
  mock.query.mockResolvedValueOnce({rows:[{id}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
  expect((await POST(request({action:'create',requestId,path:'/client/knowledge',anchor,body:'Mine.'}))).status).toBe(409);
 });
 it('bounds the complete request before parsing comment content',async()=>{
  expect((await POST(request({action:'reply',requestId,threadId:id,body:'x'.repeat(17000)}))).status).toBe(413);
  expect(mock.query).not.toHaveBeenCalled();
 });
});
