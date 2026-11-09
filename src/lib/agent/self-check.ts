import type { GroundedAnswerDecision } from "@/lib/llm/types";
import type { KnowledgeChunk } from "@/lib/types";
import { unsupportedGroundedValue } from "@/lib/agent/grounded-values";

export type PostGenerationSelfCheckResult = {
  passed: boolean;
  reasonCode: string;
  reasonDetail: string;
  confidence: number;
};

const forbiddenMutationPatterns = [
  /\b(i('|’)ve|i have|we('|’)ve|we have) (booked|reserved|cancelled|canceled|changed|modified|refunded|processed)\b/i,
  /\b(refund|payment|booking|reservation|order) (has been|is now) (processed|confirmed|completed|booked|reserved|finali[sz]ed|cancelled|canceled|changed|modified)\b/i,
  /\byour\s+(?:refund|payment|booking|reservation|order)\s+is\s+(?:processed|confirmed|completed|booked|reserved|finali[sz]ed|cancelled|canceled|changed|modified)\b/i,
  /\b(?:i|we)(?:['’]ll|\s+(?:will|shall|can))\s+(?:now\s+)?(?:refund|book|reserve|cancel|modify|approve|issue\s+(?:you\s+)?(?:a\s+)?refund|process\s+(?:(?:your|the|a)\s+)?(?:refund|payment|booking|reservation|order))\b/i,
  /\b(?:refund|payment|booking|reservation|order)\s+(?:will|shall)\s+be\s+(?:approved|processed|confirmed|cancelled|canceled|changed|modified)\b/i,
  /已经(预订|取消|更改|退款|处理)/,
  /\b(saya|kami) telah (tempah|batalkan|ubah|bayar balik|proses)\b/i,
];

const stopwords = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "for",
  "from",
  "have",
  "that",
  "the",
  "this",
  "with",
  "you",
  "your",
  "anda",
  "awak",
  "dan",
  "dari",
  "ini",
  "itu",
  "kami",
  "the",
  "untuk",
]);

const cjkStopCharacters = new Set("的是了在和有吗我你他她它们这那");

export function evaluatePostGenerationSelfCheck(input: {
  decision: GroundedAnswerDecision;
  retrievedChunks: KnowledgeChunk[];
  clarificationContext?: string;
  operationalContext?: string;
  requireQuestion?: boolean;
  customerContext?: string;
}): PostGenerationSelfCheckResult {
  if (input.decision.action === "escalate") {
    return {
      passed: true,
      reasonCode: "model_escalated",
      reasonDetail: "The model chose escalation, so no customer answer needs grounding.",
      confidence: input.decision.confidence,
    };
  }

  if (!input.decision.answer?.trim()) {
    return failed("post_check_missing_answer", "The model chose answer without customer-facing text.");
  }

  if (!input.decision.citedChunkIds.length && !input.clarificationContext && !input.operationalContext) {
    return failed("post_check_missing_citations", "The model answer did not include source chunk citations.");
  }

  const citedChunks = input.retrievedChunks.filter((chunk) =>
    input.decision.citedChunkIds.includes(chunk.id),
  );
  if (citedChunks.length !== input.decision.citedChunkIds.length) {
    return failed("post_check_invalid_citations", "The model cited chunks that were not retrieved for this turn.");
  }

  // This explicitly conditional referral describes the customer's next action
  // on Chope. It does not assert that a booking has already been completed.
  const mutationClaims = input.decision.answer.replace(/\byour\s+(?:booking|reservation)\s+is\s+confirmed\s+only\s+after\s+you\s+(?:complete|confirm)\s+(?:it|(?:your|the)\s+(?:booking|reservation))\s+(?:on|via|through)\s+Chope\b/gi, "your pending booking referral");
  if (forbiddenMutationPatterns.some((pattern) => pattern.test(mutationClaims)) ||
      affirmativeGuarantee(input.decision.answer)) {
    return failed(
      "post_check_forbidden_mutation",
      "The answer appears to promise a booking, refund, payment, order change, or other system mutation.",
    );
  }

  if (input.clarificationContext && input.requireQuestion !== false && !/[?？]/.test(input.decision.answer)) {
    return failed("post_check_missing_question", "The handoff intake did not ask a clarification question.");
  }
  const unsupported = unsupportedGroundedValue({ answer: input.decision.answer,
    citedChunks, customerContext: input.customerContext ?? input.clarificationContext });
  if (unsupported) return failed("post_check_unsupported_fact", unsupported);
  const overlap = sourceOverlapScore(input.decision.answer, citedChunks,
    [input.clarificationContext, input.operationalContext].filter(Boolean).join("\n"));
  if (overlap < 0.08) {
    return failed(
      "post_check_low_source_overlap",
      `The answer has low lexical overlap with cited sources (${overlap.toFixed(3)}).`,
    );
  }

  return {
    passed: true,
    reasonCode: "post_check_passed",
    reasonDetail: input.operationalContext ? "The reply matches the supplied assistant operating context and passed local policy checks."
      : input.clarificationContext ? "The clarification relates to the customer's message and passed local policy checks."
      : "The answer cited retrieved source chunks and passed local policy checks.",
    confidence: input.decision.confidence,
  };
}

function failed(reasonCode: string, reasonDetail: string): PostGenerationSelfCheckResult {
  return {
    passed: false,
    reasonCode,
    reasonDetail,
    confidence: 1,
  };
}

function sourceOverlapScore(answer: string, chunks: KnowledgeChunk[], clarificationContext?: string): number {
  const answerTokens = meaningfulTokens(answer);
  if (!answerTokens.length) {
    return 0;
  }
  const sourceTokens = new Set(
    [...chunks.flatMap((chunk) => meaningfulTokens(chunk.content)), ...meaningfulTokens(clarificationContext ?? "")],
  );
  const matched = answerTokens.filter((token) => sourceTokens.has(token));
  return matched.length / answerTokens.length;
}

function meaningfulTokens(text: string): string[] {
  const tokens: string[] = [];
  // Narrow multilingual equivalents help compare translated hours against the
  // same English evidence. Factual-value and citation checks still run first.
  const normalized = text.toLowerCase()
    .replace(/营业时间|營業時間|நேரம்/g, " opening hours ")
    .replace(/开门|開門|திறக்கும்|திறக்கிறது/g, " open ")
    .replace(/关门|關門|闭店|閉店|மூடும்|மூடப்படும்/g, " close ")
    .replace(/每天|每日|தினமும்/g, " daily ")
    .replace(/公众假期|公眾假期|公共假期/g, " public holiday ")
    .replace(/(?:我们|我們)(?:的)?(?:团队|團隊)/g, " our team ")
    // Staff-review acknowledgements are operating context, not new business
    // facts. Keep the mapping narrow; scalar/citation/mutation checks run first.
    .replace(/எங்கள் குழு/g, " our team ")
    .replace(/பரிசீலிக்கும்|பரிசீலித்து/g, " review ")
    .replace(/உதவும்/g, " assist ")
    .replace(/\b(?:waktu operasi|waktu buka|jam operasi)\b/g, " opening hours ")
    .replace(/\b(?:di)?buka\b/g, " open ")
    .replace(/\b(?:di)?tutup\b/g, " close ")
    .replace(/\bsetiap hari\b/g, " daily ")
    .replace(/\bcuti umum\b/g, " public holiday ");
  for (const match of normalized.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const token = match[0];
    if (/^[\u4e00-\u9fff]+$/u.test(token)) {
      tokens.push(...cjkBigrams(token));
      continue;
    }
    if (token.length > 2 && !stopwords.has(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

function affirmativeGuarantee(answer: string): boolean {
  for (const match of answer.matchAll(/\bguarantee(?:d)?\b|保证|保證/gi)) {
    const before = answer.slice(Math.max(0, match.index! - 40), match.index);
    if (/\b(?:cannot|can['’]?t|do not|don['’]t|does not|doesn['’]t|no|not|never|unable to)\s+(?:(?:safely|reliably|possibly|fully|absolutely|here)\s+)?$/i.test(before) ||
        /(?:不能(?:够|夠)?|无法|無法|不|没有|沒有)(?:在此|在这里|在這裡|完全|绝对|絕對|为您|為您|向您)?\s*$/.test(before)) continue;
    return true;
  }
  return false;
}

function cjkBigrams(value: string): string[] {
  const chars = Array.from(value).filter((char) => !cjkStopCharacters.has(char));
  if (chars.length <= 1) return chars;
  const tokens: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index]}${chars[index + 1]}`);
  }
  return tokens;
}
