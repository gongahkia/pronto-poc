import {describe,expect,it} from 'vitest';
import {huddleReviewConfig} from '@/lib/huddle-config';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
const enabled = {PRONTO_CUSTOMER_DEMO_ENABLED:'1',PRONTO_HUDDLE_ENABLED:'1'};
describe('host-backed feedback configuration',() => {
  it('requires both explicit feedback and synthetic-demo switches',() => {expect(huddleReviewConfig({})).toBeNull();expect(huddleReviewConfig({...enabled,PRONTO_HUDDLE_ENABLED:'0'})).toBeNull();expect(huddleReviewConfig({...enabled,PRONTO_CUSTOMER_DEMO_ENABLED:'0'})).toBeNull();});
  it('returns only public scope/context and uses no product service or credentials',() => {
    expect(huddleReviewConfig({...enabled,NODE_ENV:'production',PRONTO_HUDDLE_SERVER_URL:'https://unused.test',PRONTO_HUDDLE_PROJECT_ID:'obsolete',HUDDLE_ACCESS_TOKEN:'private',PRONTO_HUDDLE_RELEASE:'fixture-revision'})).toEqual({namespace:'pronto-feedback',workspace:DEMO_CLIENT_ID,environment:'development',release:'fixture-revision'});
  });
  it.each([{PRONTO_HUDDLE_ENVIRONMENT:'Not Accepted'},{PRONTO_HUDDLE_ENVIRONMENT:'x'.repeat(41)},{PRONTO_HUDDLE_RELEASE:'x'.repeat(121)}])('rejects invalid context %o',value => {expect(huddleReviewConfig({...enabled,...value})).toBeNull();});
});
