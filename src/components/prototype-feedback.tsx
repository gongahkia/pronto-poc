import { headers } from 'next/headers';
import type { SessionUser } from '@/lib/auth';
import { assertInternalFeedbackActor } from '@/lib/feedback/authorization';
import { huddleReviewConfig } from '@/lib/huddle-config';
import { DemoFeedback } from '@/components/demo-feedback';
import { HuddleFeedback } from '@/components/huddle-feedback';

export async function PrototypeFeedback({ actor, inline = false }: { actor: SessionUser; inline?: boolean }) {
  try { await assertInternalFeedbackActor(actor); }
  catch { return null; }
  const config = huddleReviewConfig();
  if (!config) return <DemoFeedback inline={inline}/>;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <HuddleFeedback config={config} styleNonce={nonce} inline={inline}/>;
}
