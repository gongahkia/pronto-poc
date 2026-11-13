import { afterEach, expect, it, vi } from 'vitest';
import { PrototypeFeedback } from '@/components/prototype-feedback';
import { DemoFeedback } from '@/components/demo-feedback';
import { HuddleFeedback } from '@/components/huddle-feedback';
const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/customer-demo', () => ({ assertDemoActor: authorize }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-nonce': 'request-nonce' }) }));
const actor = { userId: 'reviewer', email: 'reviewer@example.test', name: 'Reviewer', role: 'client' as const, clientId: 'synthetic' };
afterEach(() => { vi.unstubAllEnvs(); authorize.mockReset(); });
function enable() {
  vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED', '1'); vi.stubEnv('PRONTO_HUDDLE_ENABLED', '1');
  vi.stubEnv('PRONTO_HUDDLE_SERVER_URL', 'https://reviews.example.test');
  vi.stubEnv('PRONTO_HUDDLE_PROJECT_ID', '11111111-1111-4111-8111-111111111111');
}
it('preserves the original provider without extra identity queries by default', async () => {
  vi.stubEnv('PRONTO_HUDDLE_ENABLED', '0');
  expect((await PrototypeFeedback({ actor })).type).toBe(DemoFeedback);
  expect(authorize).not.toHaveBeenCalled();
});
it('mounts Huddle only after the existing synthetic actor check, with public props and the request nonce', async () => {
  enable(); const feedback = await PrototypeFeedback({ actor, inline: true });
  expect(authorize).toHaveBeenCalledWith(actor); expect(feedback.type).toBe(HuddleFeedback);
  expect(feedback.props).toEqual({ inline: true, styleNonce: 'request-nonce', config: {
    serverUrl: 'https://reviews.example.test', projectId: '11111111-1111-4111-8111-111111111111', environment: 'development',
  } });
});
it('keeps Pronto usable without mounting Huddle when the identity check denies or fails', async () => {
  enable(); authorize.mockRejectedValue(new Error('Identity unavailable'));
  expect((await PrototypeFeedback({ actor })).type).toBe(DemoFeedback);
});
