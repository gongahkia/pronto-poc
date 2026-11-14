import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';

export type HuddleReviewConfig = {namespace:string;workspace:string;environment:string;release?:string};
export function huddleReviewConfig(env:Record<string,string | undefined> = process.env):HuddleReviewConfig | null {
  if(env.PRONTO_HUDDLE_ENABLED !== '1' || env.PRONTO_CUSTOMER_DEMO_ENABLED !== '1') return null;
  const environment = env.PRONTO_HUDDLE_ENVIRONMENT?.trim() || 'development', release = env.PRONTO_HUDDLE_RELEASE?.trim();
  if(!/^[a-z0-9_-]{1,40}$/.test(environment) || release && release.length > 120) return null;
  return {namespace:'pronto-feedback',workspace:DEMO_CLIENT_ID,environment,...(release ? {release} : {})};
}
