import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),identity:vi.fn(),configuration:vi.fn()}));
vi.mock('@/lib/db',()=>({getPool:()=>({query:mocks.query})}));
vi.mock('@/lib/customer-demo-boundary',()=>({assertCustomerDemoEnabled:mocks.identity,DEMO_CLIENT_ID:'synthetic-client',DEMO_CHANNEL_ID:'synthetic-channel'}));
vi.mock('@/lib/customer-demo-ai',()=>({requireRealDemoConfiguration:mocks.configuration,profileForDemoChoice:()=>({provider:'groq'})}));
import {getServiceStatus} from '@/lib/service-status';
import {GET} from '@/app/api/status/route';
const good={pending:0,processing:0,stopped:0,last_success:'2026-11-13T07:00:00Z',last_failure:null,failure_code:null,cooldown_code:null,retry_after:null};
beforeEach(()=>{
 vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');vi.stubEnv('PRONTO_DEPLOYMENT_PROFILE','');vi.stubEnv('RENDER_GIT_COMMIT','a'.repeat(40));
 mocks.identity.mockResolvedValue(undefined);mocks.configuration.mockResolvedValue({provider:'groq'});
 mocks.query.mockImplementation(async(sql:string)=>({rows:sql==='select 1'?[{}]:[good]}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.clearAllMocks();});
describe('service status without inference',()=>{
 it('reports saved success and safe deployment metadata without calling a provider',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const report=await getServiceStatus();
  expect(report).toMatchObject({status:'operational',revision:'a'.repeat(40),providerProbe:false});
  expect(report.checks.find(c=>c.id==='provider')).toMatchObject({state:'ok',observedAt:'2026-11-13T07:00:00.000Z'});
  expect(report.checks.find(c=>c.id==='provider')?.detail).toMatch(/not a live provider test/);
  expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(report)).not.toContain('synthetic-client');
 });
 it('keeps the status page useful during a database outage and never returns connection secrets',async()=>{
  mocks.query.mockRejectedValueOnce(new Error('SECRET_DATABASE_URL'));
  const report=await getServiceStatus();expect(report.status).toBe('unavailable');
  expect(report.checks).toMatchObject([{id:'app',state:'ok'},{id:'database',state:'error'}]);
  expect(JSON.stringify(report)).not.toContain('SECRET');expect(mocks.configuration).not.toHaveBeenCalled();
 });
 it('distinguishes a recovered provider from old stopped messages',async()=>{
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql==='select 1'?[{}]:[{...good,last_failure:'2026-11-13T06:00:00Z',failure_code:'invalid_response',stopped:3,stopped_code:'invalid_response',stopped_at:'2026-11-13T06:00:00Z'}]}));
  const report=await getServiceStatus();expect(report.status).toBe('degraded');
  expect(report.checks.find(c=>c.id==='provider')?.state).toBe('ok');
  expect(report.checks.find(c=>c.id==='queue')?.detail).toMatch(/3 saved request/);
  expect(report.checks.find(c=>c.id==='queue')).toMatchObject({code:'invalid_response',observedAt:'2026-11-13T06:00:00.000Z'});
 });
 it('shows the latest failed attempt honestly and sanitizes unknown error text',async()=>{
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql==='select 1'?[{}]:[{...good,last_failure:'2026-11-13T07:10:00Z',failure_code:'SECRET_PROVIDER_PAYLOAD'}]}));
  const report=await getServiceStatus();expect(report.status).toBe('degraded');
  expect(report.checks.find(c=>c.id==='provider')).toMatchObject({state:'warning',code:'processing_error'});
  expect(JSON.stringify(report)).not.toContain('SECRET');
 });
 it('reports an active cooldown even when the last completed reply succeeded',async()=>{
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql==='select 1'?[{}]:[{...good,cooldown_code:'rate_limited',retry_after:'2026-11-13T07:20:00Z'}]}));
  const report=await getServiceStatus();expect(report.checks.find(c=>c.id==='provider')).toMatchObject({state:'warning',code:'rate_limited'});
 });
 it('returns machine-readable degraded status with no caching',async()=>{
  mocks.configuration.mockRejectedValueOnce(new Error('SECRET_KEY'));
  const response=await GET();expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(await response.json())).not.toContain('SECRET');
 });
 it('does not publish malformed deployment environment values',async()=>{
  vi.stubEnv('RENDER_GIT_COMMIT','SECRET_TOKEN');expect((await getServiceStatus()).revision).toBeNull();
 });
});
