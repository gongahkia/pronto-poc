import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPool} from '@/lib/db';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {removePsCafeDemo,setupPsCafeDemo} from '../../scripts/demo/ps-cafe-raffles-city';
import {verifyPassword} from '@/lib/password';
import {hasStaffCapability} from '@/lib/staff-permissions';
import type {SessionUser} from '@/lib/auth';
const mock=vi.hoisted(()=>({user:vi.fn()}));
vi.mock('@/lib/auth',()=>({getSessionUser:mock.user,getSessionUserFromToken:mock.user}));
// The docker-forwarded test DB fails the loopback-address check; the demo-tenant identity query still runs for real.
vi.mock('@/lib/customer-demo-boundary',async original=>({...(await original<typeof import('@/lib/customer-demo-boundary')>()),assertCustomerDemoEnabled:vi.fn()}));
import {createGuestReviewer} from '@/lib/guest-access';
import {POST,GET} from '@/app/api/demo/feedback/route';
import {GET as exportFeedback} from '@/app/api/demo/feedback/export/route';
import {handleFeedback} from '@/lib/feedback/huddle';
const dbDescribe=process.env.PRONTO_RUN_DB_TESTS==='1'?describe:describe.skip;
const anchor={selector:'#main-content',label:'This page',quote:'',x:0.98,y:0};
const asSession=(u:{id:string;email:string;name:string;role:'client'|'operator';client_id:string|null}):SessionUser=>({userId:u.id,email:u.email,name:u.name,role:u.role,clientId:u.client_id});
dbDescribe('guest reviewers against an isolated database',()=>{
 beforeAll(async()=>{vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');await removePsCafeDemo();await setupPsCafeDemo();});
 beforeEach(async()=>{await getPool().query(`delete from users where email like '%@guest.invalid'`);await getPool().query('delete from auth_login_attempts');});
 afterAll(async()=>{await getPool().query(`delete from users where email like '%@guest.invalid'`);await removePsCafeDemo();vi.unstubAllEnvs();await getPool().end();});
 it('creates a passwordless demo-tenant user holding every staff capability',async()=>{
  const guest=await createGuestReviewer('  Keith  ','203.0.113.5');
  expect(guest).toMatchObject({name:'Keith',role:'client',client_id:DEMO_CLIENT_ID});expect(guest.email).toMatch(/^guest-[0-9a-f-]+@guest\.invalid$/);
  expect(await verifyPassword('',guest.password_hash)).toBe(false);expect(await verifyPassword('!',guest.password_hash)).toBe(false);
  for(const capability of ['knowledge.approve','channel.activate','conversation.respond','conversation.release','staff.permissions.manage','escalation.policy.manage'] as const)
   expect(await hasStaffCapability(asSession(guest),DEMO_CLIENT_ID,capability)).toBe(true);
 });
 it('refuses a missing name and bounds how fast one visitor can create guests',async()=>{
  await expect(createGuestReviewer('   ','x')).rejects.toMatchObject({status:400});
  vi.stubEnv('PRONTO_LOGIN_THROTTLE','1');
  try{
   for(let i=0;i<8;i+=1)await createGuestReviewer(`Visitor ${i}`,'198.51.100.7');
   await expect(createGuestReviewer('One too many','198.51.100.7')).rejects.toBeInstanceOf(DemoError);
   await expect(createGuestReviewer('Different visitor','198.51.100.8')).resolves.toMatchObject({name:'Different visitor'});
  }finally{vi.stubEnv('PRONTO_LOGIN_THROTTLE','');}
 });
 it('preserves the guest session while denying legacy and new internal feedback',async()=>{
  const guest=await createGuestReviewer('Keith','203.0.113.9');mock.user.mockResolvedValue(asSession(guest));
  const response=await POST(new Request('http://localhost:3000/api/demo/feedback',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify({action:'create',requestId:randomUUID(),path:'/client/knowledge',anchor,body:'Looks good to me.'})}));
  expect(response.status).toBe(403);
  expect((await GET(new Request('http://localhost:3000/api/demo/feedback'))).status).toBe(403);
  expect((await exportFeedback(new Request('http://localhost:3000/api/demo/feedback/export?complete=1'))).status).toBe(403);
  expect((await handleFeedback(new Request(`http://localhost:3000/api/demo/feedback/v2/session?workspace=${DEMO_CLIENT_ID}&environment=development`))).status).toBe(403);
  const row=(await getPool().query(`select author_name,author_user_id from demo_feedback_comments where client_id=$1 and author_user_id=$2`,[DEMO_CLIENT_ID,guest.id])).rows[0];
  expect(row).toBeUndefined();
  expect((await getPool().query('select name from users where id=$1',[guest.id])).rows[0].name).toBe('Keith');
 });
});
