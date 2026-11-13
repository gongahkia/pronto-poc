// Safe descriptions for customer and operational views. Never echo provider
// payloads, prompts or free-form database errors into a public status response.
const descriptions:Record<string,string>={
 invalid_response:'The AI response could not be validated. This does not establish that the provider is offline.',
 malformed_response:'The AI returned an unusable response format. No invalid answer was delivered.',
 output_truncated:'The AI response ended before it was complete. No partial answer was delivered.',
 rate_limited:'The AI provider is temporarily limiting requests.',
 provider_cooldown:'The AI provider is in a recovery delay.',
 quota_exhausted:'The AI provider quota is exhausted. The demo operator needs to check the provider account.',
 authentication:'The AI provider rejected its credentials. The demo operator needs to check the server configuration.',
 configuration:'The assistant configuration needs attention from the demo operator.',
 timeout:'The AI request timed out before a reply was completed.',
 unavailable:'The AI provider could not be reached or returned a service error.',
 processing_error:'Reply processing failed. The exact cause has not been classified.',
 prompt_budget:'The request exceeded the assistant prompt limit.',
 turn_budget_calls:'The reply reached its model-call limit.',
 turn_budget_tokens:'The reply reached its token limit.',
 turn_budget_timeout:'The reply reached its processing deadline.',
};
export function replyFailure(code:unknown){
 const key=typeof code==='string'&&Object.prototype.hasOwnProperty.call(descriptions,code)?code:'processing_error';
 return {code:key,detail:descriptions[key]};
}
