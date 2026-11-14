import type {SessionUser} from '@/lib/auth';
import {assertDemoActor} from '@/lib/customer-demo';
import {DemoError} from '@/lib/customer-demo-boundary';
import {protectedDemoConfiguration,protectedDemoDeployment} from '@/lib/deployment-profile';
import {isGuestEmail} from '@/lib/guest-policy';
import {enterTenantContext} from '@/lib/tenant-context';
import type {Queryable} from '@/lib/db';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
