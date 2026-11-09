import { z } from "zod";
import { estimateTokens } from "@/lib/knowledge/chunk";
import { approvedChopeBookingLink, buildChopeListingLink, validateAvailabilityRequest } from "@/lib/reservations/chope";
import { getCachedChopeAvailability, type CachedAvailability } from "@/lib/reservations/availability-cache";
import type { GenerateAnswerInput, GroundedAnswerDecision, LlmProvider } from "@/lib/llm/types";
import type { KnowledgeChunk } from "@/lib/types";
import type { ReservationConnector } from "@/lib/reservations/types";

export const reservationQuerySchema = z.object({
  intent: z.enum(["booking", "availability", "staff_action", "other"]),
  outlet: z.enum(["current", "other", "unspecified"]),
  date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  partySize: z.number().int().min(1).max(100).nullable(),
  children: z.number().int().min(0).max(100).nullable(),
}).strict();
export type ReservationQuery = z.infer<typeof reservationQuerySchema>;
export type ReservationModelContext = {
  chunk: KnowledgeChunk; metadata: Record<string, unknown>; allowedUrls: string[];
  status: string; extraction: GroundedAnswerDecision;
};

export function reservationClarificationContext(answer: string, context: ReservationModelContext):
  { operationalContext: string } | null {
  const request = context.metadata.request as ReservationQuery | undefined;
  if (!request || context.metadata.requiresStaff || !/[?？]/.test(answer) ||
      (!context.metadata.invalidOrPastRequest && request.date !== null && request.time !== null && request.partySize !== null)) return null;
  if (context.metadata.invalidOrPastRequest) return { operationalContext:
    "The requested booking date or time has passed. Ask which future date or later time the customer would like; preserve the party size already supplied." };
  const missing = [request.date === null ? "Ask which date or day the customer would like to book." : "",
    request.time === null ? "Clarify what time they mean: did the customer mean morning/am or evening/pm?" : "",
    request.partySize === null ? "Ask how many people or guests will be dining, or their party size." : ""].filter(Boolean).join(" ");
  return { operationalContext: `An ordinary booking clarification may ask only for missing request details. ${missing}` };
}

function ambiguousBookingTimes(customerMessage: string): string[] | undefined {
  const unqualified = [...customerMessage.matchAll(/\b(?:at|around)\s+(\d{1,2})(?::([0-5]\d))?(?![\d:])(?!\s*[ap]\.?m)(?!\s*(?:noon|midnight)\b)/gi)].at(-1);
  const qualified = [...customerMessage.matchAll(/\b\d{1,2}(?::[0-5]\d)?\s*[ap]\.?m\b/gi)].at(-1);
  if (qualified && unqualified && qualified.index! > unqualified.index!) return undefined;
  const hour = unqualified ? Number(unqualified[1]) : 0;
  return hour >= 1 && hour <= 12 ? [hour % 12, hour % 12 + 12]
    .map(value => `${String(value).padStart(2, "0")}:${unqualified![2] ?? "00"}`) : undefined;
}

export function reservationDateError(request: ReservationQuery, message: string, now: Date): string | null {
  if (!request.date) return null;
  const date = new Date(`${request.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== request.date) return "The extracted calendar date is invalid";
  const explicit = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(message);
  if (explicit && explicit[1] !== request.date) return `The customer explicitly supplied ${explicit[1]}, not ${request.date}`;
  if (!explicit) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const offset = /\bday after tomorrow\b/i.test(message) ? 2 : /\btomorrow\b/i.test(message) ? 1
      : /\byesterday\b/i.test(message) ? -1 : /\btoday\b/i.test(message) ? 0 : null;
    if (offset !== null) {
      const expected = new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
      if (request.date !== expected) return `The customer's relative date resolves to ${expected} in Singapore, not ${request.date}`;
    }
  }
  const weekday = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(message);
  if (weekday && new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(date).toLowerCase() !== weekday[1].toLowerCase())
    return `${request.date} is not ${weekday[1]}; use the authoritative calendar`;
  if (weekday && /\bthis\s+\w+day\b/i.test(message) && date.getTime() > now.getTime() + 7 * 86_400_000)
    return "This weekday refers to the upcoming week, not a later week";
  return null;
}

export function mayNeedReservationContext(message: string, recent: { senderRole: string; body: string }[]): boolean {
  const topic = /\b(book(?:ing)?|reserv(?:e|ation)|table|availability|available slots)\b/i;
  return topic.test(message) || recent.filter(row => row.senderRole === "customer").slice(-2).some(row => topic.test(row.body));
}

export async function prepareReservationContext(input: {
  generation: GenerateAnswerInput; provider: Pick<LlmProvider, "generateGroundedAnswer">;
  profile: Record<string, unknown>; connector: ReservationConnector | null; now?: Date;
  onExtraction: (decision: GroundedAnswerDecision) => Promise<void>;
}): Promise<ReservationModelContext | null> {
  const link = approvedChopeBookingLink(input.profile);
  const clientId = input.generation.clientId;
  if (!link || !clientId) return null;
  const now = input.now ?? new Date();
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = Date.parse(`${localDate}T00:00:00+08:00`);
  const calendar = Array.from({ length: 15 }, (_, index) => {
    const date = new Date(start + index * 86_400_000);
    return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)} ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "long" }).format(date)}`;
  });
  let extraction: GroundedAnswerDecision | undefined;
  let request: ReservationQuery | undefined;
  let validationError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    extraction = await input.provider.generateGroundedAnswer({ ...input.generation,
      conversationalTurn: true, retrievedChunks: [], maxOutputTokens: 550,
      reservationExtraction: { now: `${localDate} ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", timeStyle: "short" }).format(now)} SGT`, calendar, validationError } });
    await input.onExtraction(extraction);
    let parsed: unknown;
    try { parsed = JSON.parse(extraction.answer ?? "null"); } catch { return null; }
    // Keep other supplied details when one count is invalid. An invalid count
    // becomes a missing detail to clarify, never a guessed or rounded party.
    if(parsed && typeof parsed==='object' && !Array.isArray(parsed)){
      const fields=parsed as Record<string,unknown>;
      if(typeof fields.partySize==='number'&&(!Number.isInteger(fields.partySize)||fields.partySize<1))fields.partySize=null;
      if(typeof fields.children==='number'&&(!Number.isInteger(fields.children)||fields.children<0))fields.children=null;
    }
    const checked = reservationQuerySchema.safeParse(parsed);
    if (!checked.success || extraction.action !== "answer") return null;
    request = checked.data;
    validationError = reservationDateError(request, input.generation.customerMessage, now) ?? undefined;
    if (!validationError) break;
  }
  if (!request || !extraction) return null;
  // A failed repair becomes a missing date, never a lookup for the wrong day.
  if (validationError) request = { ...request, date: null };
  // The public listing's default is adults-only when no child breakdown was
  // supplied. A model's null is not evidence that the customer mentioned kids.
  const customerContext = [...input.generation.recentMessages.filter(message => message.senderRole === "customer").map(message => message.body), input.generation.customerMessage].join("\n");
  if (request.children === null && !/\b(children|child|kids?|toddlers?|infants?)\b/i.test(customerContext))
    request = { ...request, children: 0 };
  if (["other", "staff_action"].includes(request.intent)) return null;
  const lastCount=[...input.generation.customerMessage.matchAll(/(?<![\d.])(-?\d+(?:\.\d+)?)\s+(?:adults?|people|persons?|guests?)\b/gi)].at(-1);
  if(lastCount && (!Number.isInteger(Number(lastCount[1]))||Number(lastCount[1])<1))request={...request,partySize:null};
  const ambiguousCurrentTime = ambiguousBookingTimes(input.generation.customerMessage);
  // Do not let a model guess AM/PM from an explicitly unqualified latest time.
  // A later explicit correction such as "actually 7pm" clears this ambiguity.
  if (ambiguousCurrentTime) request = { ...request, time: null };
  const policy = input.profile.reservationPolicy as { manualHandoffPartySize?: number } | undefined;
  const groupThreshold = policy?.manualHandoffPartySize;
  const requiresStaff = request.outlet === "other" || request.children !== 0 ||
    (request.partySize !== null && (request.partySize > 20 || (typeof groupThreshold === "number" && request.partySize >= groupThreshold)));
  const base = { clientId, outletId: link.outletId, date: request.date ?? "", partySize: request.partySize ?? 0 };
  const ambiguousTimeOptions = request.time === null ? ambiguousCurrentTime ??
    (request.intent === "booking" ? ambiguousBookingTimes(customerContext) : undefined) : undefined;
  const validParameters = !!request.date && !!request.partySize &&
    validateAvailabilityRequest({ ...base, ...(request.time ? { time: request.time } : {}) }, now);
  const invalidOrPastRequest = !!request.date && !!request.partySize && !validParameters && !requiresStaff;
  const missingDetails = [request.date === null ? "date" : "", request.partySize === null ? "partySize" : "",
    request.time === null && (request.intent === "booking" || ambiguousTimeOptions?.length) ? "time" : "",
    invalidOrPastRequest ? "future date/time" : ""].filter(Boolean);
  const requiresClarification = !requiresStaff && missingDetails.length > 0;
  const valid = !requiresStaff && !requiresClarification && validParameters;
  let observation: CachedAvailability | null = null;
  if (valid && input.connector) observation = await getCachedChopeAvailability(base, input.connector);
  const status = observation?.result.status ?? "unknown";
  const slots = observation?.result.availableSlots ?? [];
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const nearest = [...slots].sort((a, b) => request.time
    ? Math.abs(toMinutes(a) - toMinutes(request.time)) - Math.abs(toMinutes(b) - toMinutes(request.time)) || a.localeCompare(b)
    : a.localeCompare(b)).slice(0, 4);
  const times = [...new Set([...(valid && request.time ? [request.time] : []), ...nearest])];
  const choices = times.map(time => {
    const built = buildChopeListingLink({ mapping: { ...link, clientId, provider: "chope" },
      request: { ...base, time }, capability: "experimental_chope_listing_v1", now });
    return { time, observedAvailable: slots.includes(time), url: built.status === "preselected" ? built.url : link.url };
  });
  const metadata = { provider: "chope", outletId: link.outletId, request, requiresStaff,
    requiresClarification, missingDetails, ambiguousTimeOptions,
    invalidOrPastRequest,
    status, observedAt: observation?.result.observedAt ?? null, timezone: "Asia/Singapore",
    observedSlots: slots, choices, generalUrl: link.url,
    errorCode: observation?.result.errorCode ?? (!input.connector ? "missing_authorization" : null),
    cacheHit: observation?.cacheHit ?? false, observationId: observation?.observationId ?? null,
    downstreamPreselection: "unverified", extractionProviderResponseId: extraction.providerResponseId ?? null };
  const content = `Chope public availability and booking referral for ${input.generation.clientName}.\n${JSON.stringify(metadata)}\n${requiresStaff
    ? "This request is outside the supported current-outlet adults-only booking referral; ask the team to assist. Do not imply unsupported child/group/outlet selections were checked."
    : invalidOrPastRequest ? "The requested booking date or time has passed. Ask one brief question for a future date or later time, preserving the party size already supplied. No read was attempted. Do not substitute a general booking link or treat this as a provider outage."
    : requiresClarification ? `This is an incomplete ordinary booking request. Ask one brief question for only these missing details: ${missingDetails.join(", ")}. If ambiguousTimeOptions is supplied, clarify which interpretation the customer means; these are not observed available slots. No live read was attempted. Do not treat this as a provider outage or a reason for staff handoff.`
    : "Only published observations above support availability claims. Unknown means a read could not establish availability. Use the requested date/time/party; ask only for missing or ambiguous details. No booking was created. Complete on Chope and verify selections; preselection is experimental."}`;
  return { chunk: { id: `chope:${link.outletId}:${request.date ?? "pending"}:${request.partySize ?? "pending"}`,
    source_id: "integration-source:chope", client_id: clientId, chunk_index: 0, content,
    token_estimate: estimateTokens(content), score: 1, metadata: { sourceTitle: "Chope · PS.Cafe reservation availability",
      sourceUrl: link.url, live_source: true, reservation: metadata } },
    metadata, allowedUrls: [...new Set([link.url, ...choices.map(choice => choice.url)])], status, extraction };
}

export function reservationReplyError(answer: string, context: ReservationModelContext): string | null {
  const urls = answer.match(/https?:\/\/[^\s<>]+/g) ?? [];
  if (urls.some(raw => {
    const url = raw.replace(/[).,;!?]+$/, "");
    try { return new URL(url).hostname.endsWith("chope.co") && !context.allowedUrls.includes(url); }
    catch { return true; }
  })) return "The answer used a Chope URL that was not supplied by the scoped booking tool.";
  if (context.status !== "available") {
    for (const claim of answer.matchAll(/\b(?:is|are|appears?|looks?)\s+(?:to be\s+)?available\b|\bavailability (?:is )?confirmed\b/gi)) {
      const before = answer.slice(Math.max(0, claim.index! - 35), claim.index);
      const negated = /\b(?:not|never|no|isn['’]t|aren['’]t|didn['’]t|doesn['’]t|don['’]t)\s*$/i.test(before);
      // An observed absence supports "did not appear available". A failed
      // read supports neither an affirmative nor a negative inventory claim.
      if (!negated || context.status !== "unavailable")
        return "The answer claimed availability without a successful current availability observation.";
    }
  }
  return null;
}
