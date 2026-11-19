import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPool} from '@/lib/db';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {removePsCafeDemo,setupPsCafeDemo} from '../../scripts/demo/ps-cafe-raffles-city';
import {verifyPassword} from '@/lib/password';
import {hasStaffCapability} from '@/lib/staff-permissions';
// The docker-forwarded test DB fails the loopback-address check; the demo-tenant identity query still runs for real.
vi.mock('@/lib/customer-demo-boundary',async original=>({...(await original<typeof import('@/lib/customer-demo-boundary')>()),assertCustomerDemoEnabled:vi.fn()}));
import {createGuestReviewer} from '@/lib/guest-access';
import type {SessionUser} from '@/lib/auth';
const dbDescribe=process.env.PRONTO_RUN_DB_TESTS==='1'?describe:describe.skip;
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
});
