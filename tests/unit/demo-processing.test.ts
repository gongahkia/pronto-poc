import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({enabled:vi.fn(),config:vi.fn(),actor:vi.fn(),query:vi.fn(),process:vi.fn(),flush:vi.fn()}));
vi.mock('@/lib/deployment-profile',()=>({requestDrivenDemoProcessing:mock.enabled,protectedDemoConfiguration:mock.config,protectedDemoDeployment:()=>true}));
vi.mock('@/lib/customer-demo',()=>({assertDemoActor:mock.actor}));
vi.mock('@/lib/db',()=>({query:mock.query}));
vi.mock('@/lib/channels/inbox-worker',()=>({processInboundJob:mock.process}));
vi.mock('@/lib/channels/outbox',()=>({flushOutboundMessage:mock.flush}));
vi.mock('@/lib/logger',()=>({logWarn:vi.fn()}));
import {processDemoQueue} from '@/lib/demo-processing';
import {DEMO_CLIENT_ID,DEMO_CHANNEL_ID,DemoError} from '@/lib/customer-demo-boundary';
import type {SessionUser} from '@/lib/auth';
const actor:SessionUser={userId:'actor',clientId:DEMO_CLIENT_ID,role:'client',email:'qa@demo.test',name:'QA'};
afterEach(()=>vi.unstubAllEnvs());
describe('bounded protected request processing',()=>{
 it('keeps live Instagram processing when customer simulation is retired',async()=>{
  vi.stubEnv('PRONTO_CUSTOMER_SIMULATOR_ENABLED','0');vi.stubEnv('PRONTO_DEMO_INSTAGRAM_ENABLED','1');
  const instagram='4c1917a4-4bea-4fda-8671-58b6979ac10a';
  vi.stubEnv('PRONTO_DEMO_INSTAGRAM_CHANNEL_ID',instagram);vi.stubEnv('PRONTO_DEMO_INSTAGRAM_ACCOUNT_ID','123');vi.stubEnv('PRONTO_DEMO_INSTAGRAM_SENDER_IDS','456');
  await processDemoQueue(actor);
  expect(mock.process).toHaveBeenCalledExactlyOnceWith({clientId:DEMO_CLIENT_ID,channelId:instagram,requestId:'demo-request'});
 });
 beforeEach(()=>{vi.clearAllMocks();mock.enabled.mockReturnValue(true);mock.actor.mockResolvedValue(undefined);mock.process.mockResolvedValue(null);mock.query.mockResolvedValue({rows:[],rowCount:0});});
 it('fails closed outside the explicit profile and for uninvited actors',async()=>{
  mock.enabled.mockReturnValue(false);await expect(processDemoQueue(actor)).rejects.toMatchObject({status:404});expect(mock.query).not.toHaveBeenCalled();
  mock.enabled.mockReturnValue(true);mock.actor.mockRejectedValue(new DemoError('Forbidden',403));await expect(processDemoQueue(actor)).rejects.toMatchObject({status:403});expect(mock.process).not.toHaveBeenCalled();
 });
 it('always binds execution/recovery to the exact synthetic tenant and transport',async()=>{
  expect(await processDemoQueue(actor)).toMatchObject({busy:false,processed:0});
  expect(mock.process).toHaveBeenCalledWith({clientId:DEMO_CLIENT_ID,channelId:DEMO_CHANNEL_ID,requestId:'demo-request'});
  for(const [sql,values] of mock.query.mock.calls){expect(values[0]).toBe(DEMO_CLIENT_ID);if(sql.includes('channel_id'))expect(values[1]).toBe(DEMO_CHANNEL_ID);}
  const recovery=mock.query.mock.calls.find(([sql])=>sql.includes('update outbound_messages'));
  expect(recovery?.[0]).toContain("ch.kind='console'");expect(recovery?.[0]).toContain("o.status='sending'");
 });
 it('serializes overlapping requests but rechecks authorization before reporting busy',async()=>{
  let release!:(value:null)=>void;mock.process.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
  const first=processDemoQueue(actor);await vi.waitFor(()=>expect(mock.process).toHaveBeenCalledTimes(1));
  expect(await processDemoQueue(actor)).toMatchObject({busy:true});mock.actor.mockRejectedValueOnce(new DemoError('Forbidden',403));await expect(processDemoQueue(actor)).rejects.toMatchObject({status:403});
  release(null);await first;await processDemoQueue(actor);expect(mock.process).toHaveBeenCalledTimes(2);
 });
 it('keeps a processing failure recoverable and still flushes already saved replies',async()=>{
  mock.process.mockRejectedValueOnce(new Error('Synthetic interruption'));
  expect(await processDemoQueue(actor)).toMatchObject({failed:true});
  expect(await processDemoQueue(actor)).toMatchObject({failed:false});
  expect(mock.query.mock.calls.filter(([sql])=>sql.startsWith('select id from outbound_messages'))).toHaveLength(4);
 });
});
