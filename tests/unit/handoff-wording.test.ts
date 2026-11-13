import {describe,it,expect} from 'vitest';
import {hasCommittedHandoff,handoffFollowupNotice} from '@/lib/agent/handoff-wording';
import {handoffReplyFromDecision} from '@/lib/agent/handoff-intake';
const replies=['Our team will help with this enquiry.','我们的团队会协助您跟进。','Pasukan kami akan membantu anda.','எங்கள் குழு உங்களுக்கு உதவும்.'];
describe('portable handoff messages',()=>{
 it.each(replies)('accepts a firm acknowledgement in a supported language: %s',answer=>{
  expect(hasCommittedHandoff(answer)).toBe(true);
  expect(handoffReplyFromDecision({decision:{action:'escalate',answer,confidence:1,citedChunkIds:[],reasonCode:'unknown',reasonDetail:'Staff review'},chunks:[],customerMessage:'A question for staff',askForDetails:false,provider:'groq',model:'demo',retrievalMode:'local_text'})?.body).toBe(answer);
 });
 it.each(['Could our team help?','Would you like our team to help?','Our team can review this.','Our team will help?','Our team will not help.','Could you share your order reference?'])(
  'does not treat an offer or question as committed staff review: %s',answer=>expect(hasCommittedHandoff(answer)).toBe(false));
 it('keeps useful missing-detail questions after a committed acknowledgement',()=>{
  expect(hasCommittedHandoff('Our team will help. Could you share your order reference?')).toBe(true);
 });
 it('uses the reply language for the operational notice',()=>{
  expect(handoffFollowupNotice(replies[0])).toMatch(/^I can still help/);
  expect(handoffFollowupNotice(replies[1])).toMatch(/其他问题/);
  expect(handoffFollowupNotice(replies[2])).toMatch(/^Sementara itu/);
  expect(handoffFollowupNotice(replies[3])).toMatch(/^இதற்கிடையில்/);
 });
});
