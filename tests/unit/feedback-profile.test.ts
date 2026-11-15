import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CollaborationError} from '@huddle/host';
import {DemoError,DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
const mock=vi.hoisted(()=>({session:vi.fn(),actor:vi.fn(),enabled:vi.fn(),lock:vi.fn(),query:vi.fn(),audit:vi.fn()}));
vi.mock('@/lib/auth',()=>({getSessionUser:mock.session}));
vi.mock('@/lib/feedback/authorization',()=>({assertFeedbackActor:mock.actor}));
vi.mock('@/lib/feedback/state',()=>({assertFeedbackEnabled:mock.enabled,lockFeedbackTransaction:mock.lock}));
vi.mock('@/lib/audit',()=>({recordAuditLog:mock.audit}));
vi.mock('@/lib/db',()=>({query:mock.query,transaction:async(run:(db:unknown)=>unknown)=>run({query:mock.query})}));
import {POST} from '@/app/api/demo/feedback/profile/route';
const actor={userId:'00000000-0000-4000-8000-000000001111',name:'Cozy Turtle',email:'visitor@guest.invalid',clientId:DEMO_CLIENT_ID,role:'client'};
const request=(body:unknown,origin='http://localhost:3000')=>new Request('http://localhost:3000/api/demo/feedback/profile',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();mock.session.mockResolvedValue(actor);mock.actor.mockImplementation(async(value:unknown)=>{if(!value)throw new DemoError('Sign in.',401);return value;});mock.query.mockImplementation(async(sql:string,values:unknown[])=>({rows:sql.startsWith('insert')?[{attempts:1}]:[{name:values[0]}]}));});
describe('host-owned guest reviewer profile',()=>{
 it('updates only the session guest inside the feedback writer lock, with an audit record',async()=>{
  const response=await POST(request({name:'  Friendly Reviewer  '}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({name:'Friendly Reviewer'});
  expect(mock.lock).toHaveBeenCalledWith(expect.anything(),'huddle');expect(mock.actor).toHaveBeenCalledTimes(2);expect(mock.query.mock.calls[1][1]).toEqual(['Friendly Reviewer',actor.userId,DEMO_CLIENT_ID,'%@guest.invalid']);expect(mock.audit).toHaveBeenCalledWith(expect.objectContaining({actorUserId:actor.userId,targetId:actor.userId,action:'feedback.reviewer_name_changed'}),expect.anything());
 });
 it('generates a suggested name for a deliberately blank name',async()=>{const response=await POST(request({name:''}));expect(response.status).toBe(200);expect((await response.json()).name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);});
 it('requires a session and refuses named account edits through the guest endpoint',async()=>{mock.session.mockResolvedValueOnce(null);expect((await POST(request({name:'Other'}))).status).toBe(401);mock.session.mockResolvedValueOnce({...actor,email:'named@example.test'});expect((await POST(request({name:'Other'}))).status).toBe(403);expect(mock.query).not.toHaveBeenCalled();});
 it('checks origin before authentication or writes',async()=>{expect((await POST(request({name:'Other'},'https://foreign.test'))).status).toBe(403);expect(mock.session).not.toHaveBeenCalled();expect(mock.query).not.toHaveBeenCalled();});
 it.each([{name:'Other',userId:'someone-else'},{name:42},{},[],{name:'x'.repeat(41)}])('rejects malformed or impersonation fields: %j',async body=>{expect((await POST(request(body))).status).toBe(400);expect(mock.query).not.toHaveBeenCalled();});
 it('bounds the body before parsing and rejects malformed JSON',async()=>{expect((await POST(request({name:'x'.repeat(2048)}))).status).toBe(413);expect((await POST(new Request('http://localhost:3000/api/demo/feedback/profile',{method:'POST',headers:{origin:'http://localhost:3000'},body:'{'}))).status).toBe(400);expect(mock.query).not.toHaveBeenCalled();});
 it('honors maintenance and readonly locks before any profile write',async()=>{mock.lock.mockRejectedValue(new CollaborationError('unavailable','Feedback is temporarily read-only.'));expect((await POST(request({name:'Other'}))).status).toBe(503);expect(mock.query).not.toHaveBeenCalled();});
 it('limits repeated edits and rejects a stale guest row',async()=>{mock.query.mockResolvedValueOnce({rows:[{attempts:21}]});expect((await POST(request({name:'Other'}))).status).toBe(429);expect(mock.query).toHaveBeenCalledTimes(1);mock.query.mockResolvedValueOnce({rows:[{attempts:1}]}).mockResolvedValueOnce({rows:[]});expect((await POST(request({name:'Other'}))).status).toBe(403);expect(mock.audit).not.toHaveBeenCalled();});
});
