import type { KnowledgeChunk } from "@/lib/types";

type Fact = { kind: "time" | "price" | "date" | "url"; value: string; start: number; end: number };
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function calendarDate(year: string | undefined, month: number, day: number): string {
  const date = new Date(Date.UTC(Number(year ?? "2000"), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "invalid-date";
  return `${year ?? "*"}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function clock(hour: number, minute: number, period = ""): string | null {
  if (minute > 59 || hour > 23) return null;
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (/pm|petang|malam|下午|晚上|傍晚|பிற்பகல்|மாலை|இரவு/i.test(period)) hour += 12;
    if (/中午/.test(period) && hour < 11) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function canonicalEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/&amp;/g, "&").replace(/[).,;!?。），]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function extractGroundedValues(text: string): Fact[] {
  const facts: Fact[] = [];
  const add = (kind: Fact["kind"], value: string | null, start: number, length: number) => {
    if (value !== null && !facts.some(f => start < f.end && start + length > f.start))
      facts.push({ kind, value, start, end: start + length });
  };
  // Mask already classified spans so URL query parameters and dates cannot be
  // mistaken for prices or clock values.
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\\]+/gi))
    add("url", canonicalEvidenceUrl(m[0]) ?? "invalid-url", m.index!, m[0].length);
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))
    add("date", calendarDate(m[1], Number(m[2]), Number(m[3])), m.index!, m[0].length);
  for (const m of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/g))
    add("date", `numeric:${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`, m.index!, m[0].length);
  const monthPattern = months.map(m => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\.?\\s*(20\\d{2})?\\b`, "gi"))) {
    const month = months.findIndex(name => name.startsWith(m[2].toLowerCase()));
    add("date", calendarDate(m[3], month + 1, Number(m[1])), m.index!, m[0].length);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi"))) {
    const month = months.findIndex(name => name.startsWith(m[1].toLowerCase()));
    add("date", calendarDate(m[3], month + 1, Number(m[2])), m.index!, m[0].length);
  }
  for (const m of text.matchAll(/(?:\b(SGD|USD|EUR|GBP)\s*|([SUS]{0,2}\$|€|£)\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\d)/gi)) {
    const symbol = (m[1] ?? m[2]).toUpperCase();
    const currency = ({ "S$": "SGD", "US$": "USD", "€": "EUR", "£": "GBP" } as Record<string, string>)[symbol] ?? symbol;
    add("price", `${currency}:${Number(m[3].replace(/,/g, "")).toFixed(2)}`, m.index!, m[0].length);
  }
  // A dotted clock needs an explicit period (10.00am / 10.00 pagi), so an
  // ordinary decimal price or date is never promoted into a time. Consume the
  // whole clock: the old pattern incorrectly matched the suffix "00am".
  for (const m of text.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|pagi|petang|malam)\b/gi))
    add("time", clock(Number(m[1]), Number(m[2] ?? 0), m[3].replace(/\./g, "")) ?? "invalid-time", m.index!, m[0].length);
  for (const m of text.matchAll(/(上午|早上|中午|下午|晚上|傍晚)\s*(\d{1,2})[:：.](\d{2})/g))
    add("time", clock(Number(m[2]), Number(m[3]), m[1]) ?? "invalid-time", m.index!, m[0].length);
  for (const m of text.matchAll(/(காலை|பிற்பகல்|மாலை|இரவு)\s*(\d{1,2})(?:[:.](\d{2}))?\s*மணி/g))
    add("time", clock(Number(m[2]), Number(m[3] ?? 0), m[1]) ?? "invalid-time", m.index!, m[0].length);
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\b/g))
    add("time", clock(Number(m[1]), Number(m[2])) ?? "invalid-time", m.index!, m[0].length);
  for (const m of text.matchAll(/(上午|早上|中午|下午|晚上|傍晚)?(\d{1,2})[点點时時](?:(\d{1,2})分?)?/g))
    add("time", clock(Number(m[2]), Number(m[3] ?? 0), m[1]) ?? "invalid-time", m.index!, m[0].length);
  for (const m of text.matchAll(/\b(noon|midnight)\b/gi))
    add("time", m[1].toLowerCase() === "noon" ? "12:00" : "00:00", m.index!, m[0].length);
  return facts.sort((a, b) => a.start - b.start);
}

function sameValue(claim: Fact, evidence: Fact): boolean {
  if (claim.kind !== evidence.kind) return false;
  if (claim.value === evidence.value) return true;
  if (claim.kind === "date" && claim.value.startsWith("*"))
    return claim.value.slice(-5) === evidence.value.slice(-5);
  // A bare dollar symbol is acceptable wording for an explicitly sourced dollar
  // price; an explicit currency never changes into another explicit currency.
  return claim.kind === "price" && claim.value.startsWith("$:") &&
    /^(SGD|USD):/.test(evidence.value) && claim.value.split(":")[1] === evidence.value.split(":")[1];
}

function timeRole(text: string, fact: Fact): "open" | "close" | "last_order" | null {
  if (fact.kind !== "time" && fact.kind !== "date") return null;
  const before = text.slice(Math.max(0, fact.start - 100), fact.start);
  const labels = [...before.matchAll(/\b(last\s+(?:food\s+)?orders?|open(?:s|ed|ing)?|clos(?:e|es|ed|ing)|(?:di)?buka|(?:di)?tutup)\b|开门|開門|关门|關門|闭店|閉店|திறக்கும்|திறக்கிறது|மூடும்|மூடப்படும்/gi)];
  const last = labels.at(-1);
  // A last-order value is a separate fact. It must not inherit an earlier
  // opening/closing label in the same sentence or borrow the closing time.
  if(last && /^last\s/i.test(last[0]) && !/[.!?\n]/.test(before.slice(last.index!+last[0].length))) return 'last_order';
  const times = extractGroundedValues(text).filter(value => value.kind === "time");
  const index = times.findIndex(value => value.start === fact.start);
  const previous = times[index - 1], next = times[index + 1];
  const range = (from: Fact, to: Fact) => /^\s*(?:to|until|till|[-–—至到])\s*$/i.test(text.slice(from.end, to.start));
  if (previous && range(previous, fact) && /\b(open(?:ing)?|hours)\b/i.test(text.slice(Math.max(0, previous.start - 60), previous.start))) return "close";
  if (next && range(fact, next) && /\b(open(?:ing)?|hours)\b/i.test(before)) return "open";
  if (/\b(?:open\s+)?(?:until|till)\s*$/i.test(before)) return "close";
  const following = text.slice(fact.end).match(/^\s*(?:க்கு\s*)?(开门|開門|关门|關門|闭店|閉店|திறக்கும்|திறக்கிறது|மூடும்|மூடப்படும்)/);
  if (following) return /开门|開門|திறக்கும்|திறக்கிறது/.test(following[1]) ? "open" : "close";
  if (last && !/[.!?\n]/.test(before.slice(last.index! + last[0].length)))
    return /^(?:open|(?:di)?buka|开门|開門|திறக்கும்|திறக்கிறது)/i.test(last[0]) ? "open" : "close";
  return null;
}

const priceWords = new Set("a an the our your we you it its this that price prices cost costs priced is are at for only per each from to starts starting sgd usd s us can have get please pay would be will on of and plus total what how much does do".split(" "));
function priceSubject(text: string, fact: Fact): string | null {
  const fragment = text.slice(Math.max(0, fact.start - 80), fact.start).split(/[,.!?;\n]/).at(-1) ?? "";
  return [...fragment.toLowerCase().matchAll(/\b[a-z]{2,}\b/g)].map(match => match[0]).filter(word => !priceWords.has(word)).at(-1) ?? null;
}

export function unsupportedGroundedValue(input: {
  answer: string; citedChunks: KnowledgeChunk[]; customerContext?: string;
}): string | null {
  const evidence = input.citedChunks.map(chunk => ({ text: chunk.content, facts: extractGroundedValues(chunk.content) }));
  const allowedUrls = new Set(input.citedChunks.flatMap(chunk => {
    const url = typeof chunk.metadata.sourceUrl === "string" ? canonicalEvidenceUrl(chunk.metadata.sourceUrl) : null;
    return url ? [url] : [];
  }));
  for (const claim of extractGroundedValues(input.answer)) {
    if (claim.value.startsWith("invalid-")) return `Unsupported ${claim.kind} value in the customer reply.`;
    if (claim.kind === "url" && allowedUrls.has(claim.value)) continue;
    const role = timeRole(input.answer, claim);
    const subject = claim.kind === "price" ? priceSubject(input.answer, claim) : null;
    const ambiguousPrice = claim.kind === "price" && !subject &&
      new Set(evidence.flatMap(source => source.facts.filter(fact => fact.kind === "price").map(fact => fact.value))).size > 1;
    if (!ambiguousPrice && evidence.some(source => source.facts.some(fact => sameValue(claim, fact) &&
      (!role || !timeRole(source.text, fact) || role === timeRole(source.text, fact)) &&
      (!subject || !priceSubject(source.text, fact) || subject === priceSubject(source.text, fact))))) continue;
    // Customer details may be repeated in a clarification/question or an
    // explicitly attributed acknowledgement, never as new business evidence.
    const boundaries = [...input.answer.slice(0, claim.start).matchAll(/[.!?。！？](?:\s|$)|\n/g)];
    const lastBoundary = boundaries.at(-1);
    const start = lastBoundary ? lastBoundary.index! + lastBoundary[0].length : 0;
    const nextBoundary = input.answer.slice(claim.end).search(/[.!?。！？](?:\s|$)|\n/);
    const sentence = input.answer.slice(start, nextBoundary < 0 ? undefined : claim.end + nextBoundary + 1);
    // A sourced correction can explicitly reject a value supplied by the
    // customer: "10pm, not 8pm". The positive replacement must independently
    // match cited evidence; a customer's number alone never becomes evidence.
    const negativeCorrection = /(?:\bnot\s+(?:at\s+)?|\brather than\s+|\binstead of\s+|不是\s*)$/i
      .test(input.answer.slice(Math.max(start, claim.start - 30), claim.start));
    if (claim.kind !== "url" && negativeCorrection && input.customerContext &&
        extractGroundedValues(input.customerContext).some(fact => sameValue(claim, fact)) &&
        extractGroundedValues(sentence).some(other => other.kind === claim.kind && !sameValue(claim, other) &&
          evidence.some(source => source.facts.some(fact => sameValue(other, fact))))) continue;
    if (claim.kind !== "url" && input.customerContext &&
        (/\?|？/.test(sentence) || /\b(you (?:said|mentioned|requested|asked)|your (?:requested|preferred|request (?:for|to)))\b/i.test(sentence)) &&
        extractGroundedValues(input.customerContext).some(fact => sameValue(claim, fact))) continue;
    return `Unsupported ${claim.kind} value in the customer reply.`;
  }
  return null;
}
