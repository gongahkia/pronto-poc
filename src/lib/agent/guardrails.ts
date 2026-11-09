import { logWarn } from "@/lib/logger";
import type { ChannelKind } from "@/lib/types";

export type GuardrailResult = {
  shouldEscalate: boolean;
  reasonCode: string;
  reasonDetail: string;
  confidence: number;
};

export type AiDisclosureResult = {
  shouldDisclose: boolean;
  answer: string | null;
};

export type SmallTalkGreetingResult = {
  shouldAnswer: boolean;
  answer: string | null;
};

const refundComplaintPatterns = [
  /\brefund\b/i,
  /\bcomplain/i,
  /\bmissing item\b/i,
  /\blate delivery\b/i,
  /\bwrong order\b/i,
  /\bcompensation\b/i,
  /退款|退钱|投诉|少了|送迟|订单错/,
  /\b(bayaran balik|aduan|komplain|barang hilang|lambat hantar|pesanan salah|pampasan)\b/i,
  /பணம் திரும்ப|புகார்|தவறான ஆர்டர்|தாமதமான டெலிவரி/,
];

const transactionalPatterns = [
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bcancel (my )?(booking|reservation|order)\b/i,
  /\bchange (my )?(booking|reservation|order)\b/i,
  /\bmodify (my )?(booking|reservation|order)\b/i,
  /\b(can you|please|help me) (book|reserve) (a )?(table|reservation)\b/i,
  /\b(make|create) (a )?(booking|reservation)\b/i,
  /付款|支付|取消(预订|订单)|更改(预订|订单)|修改(预订|订单)|帮我订/,
  /\b(bayar|pembayaran|batalkan|ubah|tukar|tempahan|pesanan)\b/i,
  /கட்டணம்|பணம் செலுத்த|ரத்து|மாற்ற|முன்பதிவு/,
];

const privateLookupPatterns = [
  // Private booking identifiers need verified staff access, including IDs
  // presented in customer-supplied machine output.
  /\b(?:booking|reservation)[_\s-]+(?:id|ref(?:erence)?|confirmation(?:\s+number)?)\s*[:=#]?\s*(?=[A-Z0-9-]{0,29}\d)[A-Z0-9-]{4,30}\b/i,
  /\b(order|parcel|shipment|tracking|delivery)\b.*(?:#\d{3,}|\b(?=[A-Z0-9-]{0,29}\d)[A-Z0-9-]{8,30}\b)/i,
  /\b(where is my order|track my (order|parcel|shipment)|order status)\b/i,
];

const humanHandoffPatterns = [
  /\b(hop|jump|get) on (a )?(quick|short )?call\b/i,
  /\b(can|could|may) (i|we) (speak|talk|chat) (to|with) (a )?(human|person|staff|team|manager|owner|representative|agent)\b/i,
  /\b(connect|put|pass|transfer) me (to|with) (a )?(human|person|staff|team|manager|owner|representative|agent)\b/i,
  /\b(call me|phone me|ring me)\b/i,
  /\b(human|person|staff|team|manager|owner|representative) please\b/i,
  /人工|真人|客服|员工|经理|老板|负责人/,
  /\b(manusia|orang|staf|pengurus|pemilik|wakil)\b/i,
  /மனிதர்|ஊழியர்|மேலாளர்|உரிமையாளர்/,
];

const medicalLegalPatterns = [
  /\bdoctor\b/i,
  /\bmedical\b/i,
  /\blegal\b/i,
  /\bliability\b/i,
  /\bsue\b/i,
  /\bsevere allerg/i,
  /\banaphylaxis\b/i,
  /医生|医疗|法律|责任|起诉|严重过敏|过敏反应/,
  /\b(doktor|perubatan|undang-undang|liabiliti|saman|alahan teruk)\b/i,
  /மருத்துவ|சட்ட|பொறுப்பு|வழக்கு|கடுமையான அலர்ஜி/,
];

const sentimentPatterns = [
  /\burgent\b/i,
  /\basap\b/i,
  /\bnow\b/i,
  /\bangry\b/i,
  /\bfrustrated\b/i,
  /\bupset\b/i,
  /\bterrible\b/i,
  /\bawful\b/i,
  /紧急|马上|现在|生气|不满|糟糕|很差/,
  /\b(segera|cepat|sekarang|marah|kecewa|teruk)\b/i,
  /அவசரம்|இப்போது|கோபம்|ஏமாற்றம்|மோசம்/,
];

const outOfScopePatterns = [
  /\bwrite my\b/i,
  /\bhomework\b/i,
  /\binvestment advice\b/i,
  /\bweather\b/i,
  /\bnews\b/i,
  /\bcode\b(?!\s+block\b)/i,
  /\b(write|generate|debug|execute|run)\b[^.!?\n]{0,45}\b(code|program|script|python|javascript)\b/i,
  /\bkaraoke\b/i,
  /作业|投资建议|天气|新闻|代码|卡拉OK/,
  /\b(kerja rumah|nasihat pelaburan|cuaca|berita|kod|karaoke)\b/i,
  /வீட்டுப்பாடம்|முதலீட்டு ஆலோசனை|வானிலை|செய்தி|குறியீடு/,
];

const aiDisclosurePatterns = [
  /\bare (?:you|u) (?:an? )?(bot|robot|ai|artificial intelligence|human|real person)\b/i,
  /\bam i (talking|speaking) to (an? )?(bot|robot|ai|human|person)\b/i,
  /\bis this (an? )?(bot|robot|ai|human|person)\b/i,
  /\bhuman or (ai|bot|robot)\b/i,
  /你是(机器人|AI|人工智能|真人|人类)|这是(机器人|AI|人工智能|真人)/i,
  /\b(adakah|awak|kamu).*\b(bot|robot|ai|manusia)\b/i,
];

const greetingOnlyPattern =
  /^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening|morning|afternoon|evening|你好|您好|வணக்கம்)( there)?[!.?！。？\s]*$/i;
const acknowledgementOnlyPattern = /^(?:(?:thanks|thank you|thank you very much)(?:[,!\s]*(?:that is|that's|that’s) all)?|cheers|ok|okay|got it|noted|bye|goodbye|谢谢|謝謝|好的|再见|再見|terima kasih|நன்றி)[!.！。\s]*$/i;

type GuardrailCheck = {
  patterns: RegExp[];
  result: GuardrailResult;
};

const defaultGuardrailChecks: GuardrailCheck[] = [
  {
    patterns: refundComplaintPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "complaint_or_refund",
      reasonDetail:
        "Refunds, complaints, missing items, and compensation claims require a human owner.",
      confidence: 1,
    },
  },
  {
    patterns: transactionalPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "transactional_action",
      reasonDetail:
        "The v1 agent may explain process but must not create, cancel, modify, pay, refund, or mutate systems.",
      confidence: 1,
    },
  },
  {
    patterns: humanHandoffPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "human_handoff_requested",
      reasonDetail:
        "The customer asked for a call, staff member, or human takeover.",
      confidence: 1,
    },
  },
  {
    patterns: medicalLegalPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "medical_or_legal",
      reasonDetail:
        "Medical, legal, liability, or severe allergy matters always need human review.",
      confidence: 1,
    },
  },
  {
    patterns: sentimentPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "urgent_or_negative_sentiment",
      reasonDetail:
        "The customer signaled urgency or frustration, so owner attention is safer.",
      confidence: 0.95,
    },
  },
  {
    patterns: outOfScopePatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "out_of_scope",
      reasonDetail:
        "The request is outside the agreed business customer-service scope.",
      confidence: 0.9,
    },
  },
  {
    patterns: privateLookupPatterns,
    result: {
      shouldEscalate: true,
      reasonCode: "private_lookup_unverified",
      reasonDetail: "Order and tracking information requires verified requester ownership.",
      confidence: 1,
    },
  },
];

const escalationTopicPatterns: Record<string, Pick<GuardrailCheck, "patterns" | "result">> = {
  refund_dispute: {
    patterns: [/\brefund\b/i, /\bchargeback\b/i, /\bcompensation\b/i, /退款|退钱/, /\b(bayaran balik|pampasan)\b/i],
    result: defaultGuardrailChecks[0].result,
  },
  complaint: {
    patterns: [/\bcomplain/i, /\bwrong order\b/i, /\bmissing item\b/i, /\blate delivery\b/i, /投诉|订单错|少了|送迟/, /\b(aduan|komplain|pesanan salah)\b/i],
    result: defaultGuardrailChecks[0].result,
  },
  booking_mutation: {
    patterns: [
      /\bcancel (my )?(booking|reservation)\b/i,
      /\bchange (my )?(booking|reservation)\b/i,
      /\bmodify (my )?(booking|reservation)\b/i,
    ],
    result: defaultGuardrailChecks[1].result,
  },
  payment: {
    patterns: [/\bpay\b/i, /\bpayment\b/i, /\bcard\b/i],
    result: defaultGuardrailChecks[1].result,
  },
  medical_or_legal: {
    patterns: medicalLegalPatterns,
    result: defaultGuardrailChecks[3].result,
  },
  severe_allergy: {
    patterns: [/\bsevere allerg/i, /\banaphylaxis\b/i, /\ballergic reaction\b/i, /严重过敏|过敏反应/, /\b(alahan teruk|reaksi alergi)\b/i],
    result: defaultGuardrailChecks[3].result,
  },
  out_of_scope: {
    patterns: outOfScopePatterns,
    result: defaultGuardrailChecks[5].result,
  },
  human_handoff: {
    patterns: humanHandoffPatterns,
    result: defaultGuardrailChecks[2].result,
  },
};

const configurableTermFields: Array<{ field: string; reasonCode: string }> = [
  { field: "complaintOrRefundTerms", reasonCode: "complaint_or_refund" },
  { field: "transactionalActionTerms", reasonCode: "transactional_action" },
  { field: "humanHandoffTerms", reasonCode: "human_handoff_requested" },
  { field: "medicalOrLegalTerms", reasonCode: "medical_or_legal" },
  { field: "sentimentTriggers", reasonCode: "urgent_or_negative_sentiment" },
  { field: "outOfScopeTerms", reasonCode: "out_of_scope" },
];

export function evaluateAiDisclosure(
  customerMessage: string,
  clientName: string,
): AiDisclosureResult {
  if (!aiDisclosurePatterns.some((pattern) => pattern.test(customerMessage))) {
    return { shouldDisclose: false, answer: null };
  }

  return {
    shouldDisclose: true,
    answer: `I am Pronto's AI assistant for ${clientName}. I can help with verified business information, and I will escalate to the team when a human should take over.`,
  };
}

export function evaluateSmallTalkGreeting(
  customerMessage: string,
  clientName: string,
): SmallTalkGreetingResult {
  const compact = customerMessage.trim().replace(/\s+/g, " ");
  if (acknowledgementOnlyPattern.test(compact)) return { shouldAnswer: true,
    answer: `You're welcome. Our team at ${clientName} is here if you need anything else.` };
  if (!greetingOnlyPattern.test(compact)) {
    return { shouldAnswer: false, answer: null };
  }

  return {
    shouldAnswer: true,
    answer: `Hi, I can help with ${clientName}'s hours, menu, reservations, delivery, and dietary questions.`,
  };
}

export function evaluatePreGenerationGuardrails(
  customerMessage: string,
  escalationRules?: Record<string, unknown> | null,
  channelKind?: ChannelKind,
): GuardrailResult {
  const checks = buildGuardrailChecks(escalationRules, channelKind);

  for (const check of checks) {
    if (check.patterns.some((pattern) => pattern.test(customerMessage))) {
      return withChannelContext(check.result, channelKind);
    }
  }

  return {
    shouldEscalate: false,
    reasonCode: "in_scope",
    reasonDetail: channelKind
      ? `No pre-generation escalation rule matched for ${channelMessageNoun(channelKind)}.`
      : "No pre-generation escalation rule matched.",
    confidence: 0,
  };
}

function buildGuardrailChecks(
  escalationRules: Record<string, unknown> | null | undefined,
  channelKind?: ChannelKind,
): GuardrailCheck[] {
  const rules = effectiveRulesForChannel(normalizeRulesObject(escalationRules), channelKind);
  const disabledReasonCodes = new Set(stringArray(rules.disabledReasonCodes));
  const checks = defaultGuardrailChecks.map((check) => ({
    patterns: [...check.patterns],
    result: check.result,
  }));

  for (const topic of stringArray(rules.alwaysEscalateTopics)) {
    const configured = escalationTopicPatterns[topic];
    if (!configured) {
      logWarn("guardrails.unknown_escalation_topic", { topic });
      continue;
    }
    checks.push({
      patterns: configured.patterns,
      result: configured.result,
    });
  }

  for (const { field, reasonCode } of configurableTermFields) {
    const terms = stringArray(rules[field]);
    if (!terms.length) {
      continue;
    }
    const target = checks.find((check) => check.result.reasonCode === reasonCode);
    if (!target) {
      continue;
    }
    target.patterns.push(...terms.map(literalWordPattern));
  }

  return checks.filter((check) => !disabledReasonCodes.has(check.result.reasonCode));
}

function effectiveRulesForChannel(
  rules: Record<string, unknown>,
  channelKind: ChannelKind | undefined,
): Record<string, unknown> {
  if (!channelKind) {
    return rules;
  }
  const channelRules = normalizeRulesObject(rules.channelRules);
  const specificRules = normalizeRulesObject(channelRules[channelKind]);
  if (!Object.keys(specificRules).length) {
    return rules;
  }

  const merged: Record<string, unknown> = { ...rules };
  for (const { field } of configurableTermFields) {
    if (Array.isArray(specificRules[field])) {
      merged[field] = specificRules[field];
    }
  }
  if (Array.isArray(specificRules.alwaysEscalateTopics)) {
    merged.alwaysEscalateTopics = specificRules.alwaysEscalateTopics;
  }
  merged.disabledReasonCodes = [
    ...new Set([
      ...stringArray(rules.disabledReasonCodes),
      ...stringArray(specificRules.disabledReasonCodes),
    ]),
  ];
  return merged;
}

function normalizeRulesObject(escalationRules: unknown): Record<string, unknown> {
  if (!escalationRules) {
    return {};
  }
  if (typeof escalationRules === "object" && !Array.isArray(escalationRules)) {
    return escalationRules as Record<string, unknown>;
  }
  logWarn("guardrails.invalid_escalation_rules", {
    rulesType: Array.isArray(escalationRules) ? "array" : typeof escalationRules,
  });
  return {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      logWarn("guardrails.invalid_rule_field", { valueType: typeof value });
    }
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function literalWordPattern(term: string): RegExp {
  if (/[^\p{Script=Latin}\p{N}_ -]/u.test(term)) {
    return new RegExp(escapeRegExp(term), "iu");
  }
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withChannelContext(
  result: GuardrailResult,
  channelKind: ChannelKind | undefined,
): GuardrailResult {
  if (!channelKind) {
    return result;
  }
  return {
    ...result,
    reasonDetail: `Matched ${channelMessageNoun(channelKind)} triage policy. ${result.reasonDetail}`,
  };
}

function channelMessageNoun(channelKind: ChannelKind): string {
  if (channelKind === "whatsapp") return "WhatsApp message";
  if (channelKind === "telegram") return "Telegram bot message";
  if (channelKind === "instagram") return "Instagram DM";
  if (channelKind === "messenger") return "Messenger message";
  return "email";
}

export function evaluateRetrievalConfidence(
  topScore: number | undefined,
  threshold: number,
): GuardrailResult {
  const score = topScore ?? 0;
  if (score < threshold) {
    return {
      shouldEscalate: true,
      reasonCode: "low_retrieval_confidence",
      reasonDetail: `Top retrieval score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)}.`,
      confidence: score,
    };
  }

  return {
    shouldEscalate: false,
    reasonCode: "retrieval_confident",
    reasonDetail: "Retrieved source material met the configured threshold.",
    confidence: score,
  };
}
