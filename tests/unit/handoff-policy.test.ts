import {describe,it,expect} from 'vitest';
import {allowsSupportedFollowups} from '@/lib/agent/handoff-policy';

describe('issue-scoped staff reviews',()=>{
  it('allows routine issues to stay flagged without stopping other answers',()=>{
    expect(allowsSupportedFollowups('complaint_or_refund','My order has a missing item; can I get a refund?')).toBe(true);
    expect(allowsSupportedFollowups('low_retrieval_confidence','What is your cake price?')).toBe(true);
  });
  it('keeps explicit human requests, critical safety and operational failures paused',()=>{
    for(const [reason,message] of [
      ['human_handoff_requested','Can I talk to a human?'],
      ['medical_or_legal','I have a severe allergy'],
      ['provider_error','What time do you close?'],
      ['private_lookup_unverified','What is my order status?'],
      ['unverified_price','Can I talk to a human about the price?'],
      ['arbitrary_model_label','I want to speak to a person, please.'],
    ])expect(allowsSupportedFollowups(reason,message)).toBe(false);
  });
});
