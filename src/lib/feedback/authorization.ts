import type {SessionUser} from '@/lib/auth';
import {assertDemoActor} from '@/lib/customer-demo';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {protectedDemoConfiguration,protectedDemoDeployment} from '@/lib/deployment-profile';
import {guestAccessEnabled,isGuestEmail} from '@/lib/guest-policy';
import {enterTenantContext} from '@/lib/tenant-context';
import type {Queryable} from '@/lib/db';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function feedbackAccess(): 'internal' | 'public-demo' {
  const access = process.env.PRONTO_HUDDLE_ACCESS ?? 'internal';
  if(access !== 'internal' && access !== 'public-demo') throw new DemoError('Feedback access is not configured correctly.',503);
  return access;
}

// public review uses chooser-issued sessions for attribution, without interactive sign-in.
export async function assertFeedbackActor(actor:SessionUser | null,db?:Queryable):Promise<SessionUser> {
  if(feedbackAccess() === 'internal') return assertInternalFeedbackActor(actor,db);
  if(!actor) throw new DemoError('Choose a demo view to use feedback.',401);
  if(!guestAccessEnabled() || (isGuestEmail(actor.email.trim()) && (actor.role !== 'client' || actor.clientId !== DEMO_CLIENT_ID)))
    throw new DemoError('Feedback is not available for this account.',403);
  enterTenantContext(actor);
  await assertDemoActor(actor,db);
  return actor;
}

export function internalFeedbackUserIds():string[] {
  const ids = protectedDemoDeployment() ? protectedDemoConfiguration().allowedUserIds :
    (process.env.PRONTO_DEMO_ALLOWED_USER_IDS ?? '').split(',').map(id => id.trim());
  if(!ids.length || ids.length > 20 || ids.some(id => !uuid.test(id))) throw new DemoError('Internal feedback is not available for this account.',403);
  return ids.map(id => id.toLowerCase());
}

// navigation into the demo never grants internal feedback access.
export async function assertInternalFeedbackActor(actor:SessionUser | null,db?:Queryable):Promise<SessionUser> {
  if(!actor) throw new DemoError('Sign in to use internal feedback.',401);
  if(typeof actor.email !== 'string' || isGuestEmail(actor.email.trim()) || !internalFeedbackUserIds().includes(actor.userId.toLowerCase()))
    throw new DemoError('Internal feedback is not available for this account.',403);
  enterTenantContext(actor);
  await assertDemoActor(actor,db);
  return actor;
}
