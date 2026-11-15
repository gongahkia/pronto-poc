import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PrototypeFeedback} from '@/components/prototype-feedback';
import {HuddleFeedback} from '@/components/huddle-feedback';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
const {authorize,mode} = vi.hoisted(() => ({authorize:vi.fn(),mode:vi.fn()}));
vi.mock('@/lib/db',() => ({getPool:vi.fn(() => ({}))}));
vi.mock('@/lib/feedback/state',() => ({feedbackMode:mode}));
vi.mock('@/lib/feedback/authorization',() => ({assertFeedbackActor:authorize}));
vi.mock('next/headers',() => ({headers:async () => new Headers({'x-nonce':'request-nonce'})}));
const actor = {userId:'reviewer',email:'reviewer@example.test',name:'Reviewer',role:'client' as const,clientId:DEMO_CLIENT_ID};
beforeEach(() => mode.mockResolvedValue('active'));
afterEach(() => {vi.unstubAllEnvs();authorize.mockReset();mode.mockReset();});
function enable() {vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');vi.stubEnv('PRONTO_HUDDLE_ENABLED','1');}
it('disables feedback without rendering any legacy fallback',async () => {vi.stubEnv('PRONTO_HUDDLE_ENABLED','0');expect(await PrototypeFeedback({actor})).toBeNull();expect(authorize).not.toHaveBeenCalled();});
it('mounts the host-backed SDK after the central host policy with the document nonce',async () => {
  enable();const feedback = await PrototypeFeedback({actor,inline:true});expect(authorize).toHaveBeenCalledWith(actor);expect(feedback!.type).toBe(HuddleFeedback);expect(feedback!.props).toEqual({inline:true,styleNonce:'request-nonce',readOnly:false,canEditName:false,config:{namespace:'pronto-feedback',workspace:DEMO_CLIENT_ID,environment:'development'}});
});
it('keeps business pages usable and hides feedback on denial or identity failure',async () => {enable();authorize.mockRejectedValue(new Error('Identity unavailable'));expect(await PrototypeFeedback({actor})).toBeNull();});

it('keeps the adapter disabled until cutover and identifies read-only access explicitly',async () => {enable();mode.mockResolvedValueOnce('maintenance');const paused = await PrototypeFeedback({actor});expect(paused!.type).toBe('p');expect(paused!.props.children).toContain('Feedback is paused');mode.mockResolvedValueOnce('readonly');expect((await PrototypeFeedback({actor}))!.props.readOnly).toBe(true);});
