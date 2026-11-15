import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const boundary = vi.hoisted(() => ({assert:vi.fn(),protected:vi.fn(),configuration:vi.fn()}));
vi.mock('@/lib/customer-demo',() => ({assertDemoActor:boundary.assert}));
vi.mock('@/lib/deployment-profile',() => ({protectedDemoDeployment:boundary.protected,protectedDemoConfiguration:boundary.configuration}));
import {assertFeedbackActor,assertInternalFeedbackActor,feedbackAccess,internalFeedbackUserIds} from '@/lib/feedback/authorization';
const id = '00000000-0000-4000-8000-000000001111', other = '00000000-0000-4000-8000-000000002222';
const actor = {userId:id,email:'named@demo.test',name:'Named reviewer',role:'client' as const,clientId:'00000000-0000-4000-8000-00000000a101'};
beforeEach(() => {vi.clearAllMocks();boundary.protected.mockReturnValue(false);boundary.assert.mockResolvedValue(undefined);vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',id);});
afterEach(() => vi.unstubAllEnvs());
describe('central internal feedback policy',() => {
  it('defaults to internal and fails closed for unknown policies',async () => {
    vi.stubEnv('PRONTO_HUDDLE_ACCESS',undefined);expect(feedbackAccess()).toBe('internal');await expect(assertFeedbackActor({...actor,email:'visitor@guest.invalid'})).rejects.toMatchObject({status:403});
    vi.stubEnv('PRONTO_HUDDLE_ACCESS','public');await expect(assertFeedbackActor(actor)).rejects.toMatchObject({status:503});expect(boundary.assert).not.toHaveBeenCalled();
  });
  it('requires the existing authenticated session',async () => {await expect(assertInternalFeedbackActor(null)).rejects.toMatchObject({status:401});expect(boundary.assert).not.toHaveBeenCalled();});
  it.each(['reviewer@guest.invalid','reviewer@GUEST.INVALID',' reviewer@guest.invalid '])('denies guest identity %s independently of guest flow settings',async email => {
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','0'); await expect(assertInternalFeedbackActor({...actor,email})).rejects.toMatchObject({status:403}); expect(boundary.assert).not.toHaveBeenCalled();
  });
  it('does not treat an authenticated customer or operator as an invited reviewer',async () => {
    for(const role of ['client','operator'] as const) await expect(assertInternalFeedbackActor({...actor,userId:other,role})).rejects.toMatchObject({status:403});expect(boundary.assert).not.toHaveBeenCalled();
  });
  it.each(['','not-a-uuid',`${id},bad`,Array(21).fill(id).join(',')])('fails closed for invalid named-user policy %s',async ids => {
    vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS',ids);await expect(assertInternalFeedbackActor(actor)).rejects.toMatchObject({status:403});expect(boundary.assert).not.toHaveBeenCalled();
  });
  it('retains verified demo/tenant boundary checks for an explicitly invited named user',async () => {
    expect(await assertInternalFeedbackActor(actor)).toEqual(actor); expect(boundary.assert).toHaveBeenCalledWith(actor,undefined);boundary.assert.mockRejectedValueOnce(new Error('Wrong database boundary')); await expect(assertInternalFeedbackActor(actor)).rejects.toThrow('Wrong database boundary');
  });
  it('uses the verified protected deployment policy rather than a separate role or client assertion',async () => {
    boundary.protected.mockReturnValue(true);boundary.configuration.mockReturnValue({allowedUserIds:[other]}); expect(internalFeedbackUserIds()).toEqual([other]);await expect(assertInternalFeedbackActor(actor)).rejects.toMatchObject({status:403});expect(boundary.assert).not.toHaveBeenCalled();
  });
});

describe('explicit public demo feedback policy',() => {
  beforeEach(() => {vi.stubEnv('PRONTO_HUDDLE_ACCESS','public-demo');vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');vi.stubEnv('PRONTO_DEMO_ALLOWED_USER_IDS','');});
  it('admits chooser identities without a named-user entry and retains the verified database boundary',async () => {
    const visitor = {...actor,email:'visitor@guest.invalid'};expect(await assertFeedbackActor(visitor)).toEqual(visitor);expect(boundary.assert).toHaveBeenCalledWith(visitor,undefined);
    boundary.assert.mockRejectedValueOnce(new Error('Wrong demo database'));await expect(assertFeedbackActor(visitor)).rejects.toThrow('Wrong demo database');
    // rollout administration remains internal even when the website is public.
    await expect(assertInternalFeedbackActor(visitor)).rejects.toMatchObject({status:403});
  });
  it('requires an issued session, enabled demo and correct guest tenant/role',async () => {
    await expect(assertFeedbackActor(null)).rejects.toMatchObject({status:401});
    for(const visitor of [{...actor,email:'visitor@guest.invalid',clientId:other},{...actor,email:'visitor@guest.invalid',role:'operator' as const}]) await expect(assertFeedbackActor(visitor)).rejects.toMatchObject({status:403});
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','0');await expect(assertFeedbackActor(actor)).rejects.toMatchObject({status:403});expect(boundary.assert).not.toHaveBeenCalled();
  });
});
