import { headers } from 'next/headers';
import type { SessionUser } from '@/lib/auth';
import { assertDemoActor } from '@/lib/customer-demo';
import { huddleReviewConfig } from '@/lib/huddle-config';
import { DemoFeedback } from '@/components/demo-feedback';
import { HuddleFeedback } from '@/components/huddle-feedback';

export async function PrototypeFeedback({ actor, inline = false }: { actor: SessionUser; inline?: boolean }) {
  const config = huddleReviewConfig();
  if (!config) return <DemoFeedback inline={inline}/>;
  try { await assertDemoActor(actor); }
  catch {
    // Review tooling must not take down a business page. The original
    // feedback endpoints retain their own existing authorization checks.
    return <DemoFeedback inline={inline}/>;
  }
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <HuddleFeedback config={config} styleNonce={nonce} inline={inline}/>;
}
