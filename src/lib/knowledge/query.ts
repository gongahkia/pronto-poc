export type NormalizedKnowledgeQuery = {
  embeddingText: string;
  searchQuery: string;
  categories: string[];
  usedConversationContext?: boolean;
};

export function conversationKnowledgeQuery(message: string, recent: { senderRole: string; body: string }[]): NormalizedKnowledgeQuery {
  const current = normalizeKnowledgeQuery(message);
  const followUp = /^(?:and\b|also\b|what about\b|how about\b|does (?:that|it)\b|is (?:that|it)\b|for \d+\b|那|还有|還有)/i.test(message.trim()) ||
    /\b(that option|this option|the other one|instead|same one|does that|does it)\b/i.test(message);
  // An explicit new topic wins; a weekday alone is not a topic switch.
  const explicitTopic = /\b(opening hours|closing time|refund|complaint|address|directions|allerg(?:y|ic)|halal|menu|prices?)\b/i.test(message);
  const prior = recent.filter(row => row.senderRole === "customer").slice(-2).map(row => row.body.slice(0, 1000));
  if (!followUp || explicitTopic || !prior.length) return { ...current, usedConversationContext: false };
  return { ...normalizeKnowledgeQuery([...prior, message].join("\n")), usedConversationContext: true };
}

type QueryCategory = {
  id: string;
  aliases: string[];
  patterns: RegExp[];
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "can",
  "could",
  "do",
  "does",
  "for",
  "how",
  "i",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "please",
  "shop",
  "store",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "you",
  "your",
]);

const QUERY_CATEGORIES: QueryCategory[] = [
  {
    id: "opening_hours",
    aliases: [
      "opening hours",
      "operating hours",
      "business hours",
      "open today",
      "open Sunday",
      "weekend hours",
      "closing time",
      "last order",
    ],
    patterns: [
      /\b(open|opens|opened|opening|close|closes|closing|hours|time|timing|today|tomorrow|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(shop|store|restaurant|stall|outlet)\b.*\b(open|close|hours|time)\b/i,
      /\b(open|close|hours|time)\b.*\b(shop|store|restaurant|stall|outlet)\b/i,
      /\bbuka\b/i,
      /\b(tutup|opn|cls|clse|cloz|tym)\b/i,
      /\bpukul\b/i,
      /திறக்|திறக்கும்|மூட|மணிக்கு|நேரம்/,
      /营业|營業|开门|開門|几点|幾點|星期|周日|週日|周六|週六|开吗|開嗎/,
    ],
  },
  {
    id: "menu_pricing",
    aliases: [
      "menu",
      "prices",
      "pricing",
      "signature dish",
      "nasi lemak",
      "sambal",
      "drink",
      "set meal",
    ],
    patterns: [
      /\b(menu|price|prices|pricing|cost|how much|dish|meal|bowl|set|drink|sambal|spicy|nasi|lemak)\b/i,
      /菜单|菜單|价格|價錢|多少钱|多少錢/,
    ],
  },
  {
    id: "delivery",
    aliases: [
      "delivery",
      "takeaway",
      "pickup",
      "self pickup",
      "corporate order",
      "islandwide delivery",
    ],
    patterns: [
      /\b(deliver|delivery|takeaway|take away|pickup|pick up|self pickup|corporate|bulk order|catering)\b/i,
      /外送|送餐|打包|自取/,
    ],
  },
  {
    id: "reservations",
    aliases: [
      "reservation",
      "booking",
      "reserve table",
      "book table",
      "walk in",
      "dine in",
    ],
    patterns: [
      /\b(reservation|reserve|booking|book a table|table|walk in|walk-in|dine in|dine-in|seat|seating)\b/i,
      /订位|訂位|预约|預約/,
    ],
  },
  {
    id: "dietary",
    aliases: [
      "halal",
      "allergen",
      "allergy",
      "vegetarian",
      "vegan",
      "gluten",
      "peanut",
      "egg",
      "dairy",
    ],
    patterns: [
      /\b(halal|allergen|allergy|allergic|vegetarian|vegan|gluten|peanut|egg|dairy|shellfish|dietary)\b/i,
      /清真|过敏|過敏|素食/,
    ],
  },
  {
    id: "address_contact",
    aliases: [
      "address",
      "location",
      "directions",
      "nearest MRT",
      "phone",
      "contact",
      "where are you",
    ],
    patterns: [
      /\b(address|location|where are you|directions|mrt|nearby|phone|contact|whatsapp|email)\b/i,
      /地址|在哪里|在哪裡|电话|電話|联系|聯絡/,
    ],
  },
  {
    id: "complaints_refunds",
    aliases: [
      "refund",
      "complaint",
      "missing item",
      "late delivery",
      "wrong order",
      "compensation",
    ],
    patterns: [
      /\b(refund|complaint|complain|missing item|late delivery|wrong order|compensation|chargeback)\b/i,
      /退款|投诉|投訴|少了|错单|錯單/,
    ],
  },
];

export function normalizeKnowledgeQuery(message: string): NormalizedKnowledgeQuery {
  const compactMessage = message.trim().replace(/\s+/g, " ");
  const categories = QUERY_CATEGORIES.filter((category) =>
    category.patterns.some((pattern) => pattern.test(compactMessage)),
  );
  const aliasTerms = categories.flatMap((category) => category.aliases);
  const lexicalTerms = unique([
    ...tokenizeForSearch(compactMessage),
    ...aliasTerms.flatMap(tokenizeForSearch),
  ]).slice(0, 32);

  return {
    embeddingText: unique([compactMessage, ...aliasTerms]).join("\n"),
    searchQuery: lexicalTerms.join(" OR "),
    categories: categories.map((category) => category.id),
  };
}

function tokenizeForSearch(value: string): string[] {
  const asciiTerms = value
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
  const cjkTerms = value.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  return [...asciiTerms, ...cjkTerms];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
