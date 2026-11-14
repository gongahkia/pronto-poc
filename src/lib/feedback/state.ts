import {CollaborationError} from '@huddle/host';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {huddleReviewConfig} from '@/lib/huddle-config';
import type {Queryable} from '@/lib/db';

export const feedbackLock = `pronto:feedback:${DEMO_CLIENT_ID}`;
export type FeedbackMode = 'maintenance' | 'legacy' | 'active' | 'readonly';
export function assertFeedbackEnabled() {
  if(!huddleReviewConfig()) throw new DemoError('Internal feedback is disabled.',503);
}
export async function feedbackMode(db:Queryable):Promise<FeedbackMode> {
  const result = await db.query<{mode:FeedbackMode}>('select mode from prototype_feedback_state where client_id=$1',[DEMO_CLIENT_ID]);
  return result.rows[0]?.mode ?? 'maintenance';
}
// every writer holds this shared transaction lock through commit; migration takes the exclusive lock.
export async function lockFeedbackTransaction(db:Queryable,kind:'legacy' | 'huddle',readOnly=false) {
  await db.query("set local lock_timeout='1s'");
  await db.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[feedbackLock]);
  const mode = await feedbackMode(db);
  if(kind === 'legacy' ? mode !== 'legacy' : mode !== 'active' && !(readOnly && mode === 'readonly'))
    throw kind === 'legacy' ? new DemoError('Feedback writes are paused for migration or have moved to the new store.',503) :
      new CollaborationError('unavailable',mode === 'readonly' ? 'Feedback is temporarily read-only. Export remains available.' : 'Feedback is paused for verified migration.');
}
