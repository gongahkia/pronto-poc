import {describe,expect,it,vi} from 'vitest';
import {feedbackLock,lockFeedbackTransaction} from '@/lib/feedback/state';
import type {Queryable} from '@/lib/db';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
function db(mode:string) {const query = vi.fn<Queryable['query']>().mockResolvedValue({rows:[{mode}],command:'SELECT',rowCount:1,oid:0,fields:[]});return {query:query as Queryable['query'],calls:query.mock.calls};}
describe('feedback writer pause and cutover boundary',() => {
  it('locks the transaction before checking mode and retains the exact workspace predicate',async () => {
    const fixture = db('legacy');await lockFeedbackTransaction(fixture,'legacy');expect(fixture.calls.map(call => call[0])).toEqual(["set local lock_timeout='1s'",'select pg_advisory_xact_lock_shared(hashtextextended($1,0))','select mode from prototype_feedback_state where client_id=$1']);expect(fixture.calls[1][1]).toEqual([feedbackLock]);expect(fixture.calls[2][1]).toEqual([DEMO_CLIENT_ID]);
  });
  it.each(['maintenance','active','readonly'])('denies legacy writes in %s mode',async mode => {await expect(lockFeedbackTransaction(db(mode),'legacy')).rejects.toMatchObject({status:503});});
  it.each(['maintenance','legacy','readonly'])('denies SDK writes in %s mode',async mode => {await expect(lockFeedbackTransaction(db(mode),'huddle')).rejects.toMatchObject({code:'unavailable'});});
  it('permits active SDK writes and read-only export snapshots without reopening legacy writes',async () => {await expect(lockFeedbackTransaction(db('active'),'huddle')).resolves.toBeUndefined();await expect(lockFeedbackTransaction(db('readonly'),'huddle',true)).resolves.toBeUndefined();await expect(lockFeedbackTransaction(db('readonly'),'legacy',true)).rejects.toMatchObject({status:503});});
});
