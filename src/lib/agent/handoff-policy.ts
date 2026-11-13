import { evaluatePreGenerationGuardrails } from './guardrails';

export function allowsSupportedFollowups(reason: string, message: string): boolean {
  if (/provider|budget|timeout|token|security|injection|private|medical|legal|allerg|human|staff_takeover|unsupported_media|self_check|post_check/i.test(reason)) return false;
  return !evaluatePreGenerationGuardrails(message, {
    disabledReasonCodes: ['complaint_or_refund', 'transactional_action', 'out_of_scope'],
  }).shouldEscalate;
}
