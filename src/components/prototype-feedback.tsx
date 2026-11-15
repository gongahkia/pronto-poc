import { headers } from 'next/headers';
import type { SessionUser } from '@/lib/auth';
import { assertFeedbackActor } from '@/lib/feedback/authorization';
import { huddleReviewConfig } from '@/lib/huddle-config';
import { HuddleFeedback } from '@/components/huddle-feedback';
import {getPool} from '@/lib/db';
import {feedbackMode} from '@/lib/feedback/state';
import {isGuestEmail} from '@/lib/guest-policy';

export async function PrototypeFeedback({ actor, inline = false }: { actor: SessionUser; inline?: boolean }) {
  const config = huddleReviewConfig();
  if (!config) return null;
  let mode;
  try { await assertFeedbackActor(actor); mode = await feedbackMode(getPool()); }
  catch { return null; }
  if(mode !== 'active' && mode !== 'readonly') return <p data-feedback-ui role="status" className="text-xs text-muted">Feedback is paused. Contact your team.</p>;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <HuddleFeedback config={config} styleNonce={nonce} inline={inline} readOnly={mode === 'readonly'} canEditName={typeof actor.email==='string'&&isGuestEmail(actor.email)}/>;
}
