import {replyFailure} from '@/lib/reply-failure';
export type DecisionStep = {
  id: string;
  title: string;
  description: string;
  kind: "message" | "rule" | "knowledge" | "model" | "check" | "outcome" | "delivery";
  tone: "neutral" | "success" | "attention";
  modelLabel?: string;
  sources?: DecisionSource[];
};

export type DecisionSource = {
  chunkId: string; sourceId: string | null; title: string; url: string | null;
  excerpt: string | null; version: number | null; cited: boolean; snapshot: boolean;
};

export type ConversationDecision = {
  id: string;
  message: string;
  createdAt: string;
  status: string;
  steps: DecisionStep[];
};

export type DecisionRecord = {
  message_id: string;
  body: string;
  created_at: Date | string;
  ai_paused: boolean;
  trace_id: string | null;
  status: "answered" | "escalated" | 'failed' | null;
  reason_code: string | null;
  reason_detail: string | null;
  retrieval_chunk_count: number;
  cited_chunk_ids: string[] | null;
  steps: { label: string; detail?: Record<string, unknown> }[] | null;
  model_ran: boolean;
  reply_body: string | null;
  handoff_intake: boolean;
  delivery_status: string | null;
  job_status: string | null;
  job_failure_code?:string|null;
  sources?: Omit<DecisionSource, "cited">[] | null;
  model_provider?: string | null;
  model_name?: string | null;
  intake_provider?: string | null;
  intake_model?: string | null;
};

const humanize = (text: string) => text.replace(/_/g, " ");
const modelLabel = (provider?: string | null, model?: string | null) => {
  const names: Record<string, string> = { groq: "Groq", gemini: "Gemini", openai: "OpenAI", azure: "Azure OpenAI", anthropic: "Anthropic" };
  return [provider ? names[provider] ?? provider : null, model].filter(Boolean).join(" · ") || undefined;
};

export function buildConversationDecision(record: DecisionRecord): ConversationDecision {
  const steps: DecisionStep[] = [];
  const add = (title: string, description: string, kind: DecisionStep["kind"], tone: DecisionStep["tone"] = "neutral") =>
    steps.push({ id: `${record.message_id}-${steps.length}`, title, description, kind, tone });
  add("Customer message", record.body, "message");
  const events = record.steps ?? [];
  const failed=record.status==='failed'||['failed','dead'].includes(record.job_status??'');
  const rule = events.find(step => step.label === "pre_generation_escalated");
  const model = events.find(step => step.label === "model_decision");
  const context = events.find(step => step.label === "knowledge_context")?.detail?.sources;
  const snapshot = Array.isArray(context) ? context.filter((value): value is Omit<DecisionSource, "cited"> =>
    value != null && typeof value === "object" && typeof value.chunkId === "string") : [];
  const cited = new Set(record.cited_chunk_ids ?? []);
  const sources = (snapshot.length ? snapshot : record.sources ?? []).map(source => ({ ...source,
    title: source.title || record.sources?.find(fallback => fallback.chunkId === source.chunkId)?.title || "Source no longer available",
    cited: cited.has(source.chunkId) }));

  if (record.ai_paused && !record.trace_id) {
    add("Assistant paused", "Your team already owns this conversation. This message was saved for staff without another AI reply.", "rule", "attention");
  } else if (!record.trace_id) {
    if(failed)add('Reply processing failed',replyFailure(record.job_failure_code??record.reason_code).detail,'outcome','attention');
    else add(record.job_status === "pending" || record.job_status === "processing" ? "Processing" : "No decision trace recorded",
      record.job_status === "pending" || record.job_status === "processing" ? "The enquiry is waiting for a decision."
        : "There is no saved decision trace for this message. No model decision is inferred here.", "outcome");
  } else {
    if (rule) {
      add("Routing rule matched", record.reason_detail ?? humanize(record.reason_code ?? "staff review"), "rule", "attention");
    } else if (events.some(step => step.label === "pre_generation_passed")) {
      add("Initial checks passed", "The enquiry continued to knowledge retrieval and model triage.", "check", "success");
    }
    const reservation = events.find(step => step.label === "chope_availability_checked")?.detail;
    if (reservation) {
      const request = reservation.request as { date?: string; time?: string; partySize?: number } | undefined;
      add("Chope availability checked", [
        request?.date ? `${request.partySize ?? "?"} guests · ${request.date}${request.time ? ` · ${request.time}` : ""} SGT.` : "Booking details are incomplete.",
        reservation.status === "available" || reservation.status === "unavailable"
          ? `Observed ${reservation.status} at ${String(reservation.observedAt)}${reservation.cacheHit ? " (cached observation)" : ""}.`
          : "Current availability could not be verified. No available time is inferred.",
        "The customer completes the booking on Chope.",
      ].join(" "), "check", reservation.status === "available" ? "success" : "neutral");
    }
    if (record.retrieval_chunk_count > 0 || events.some(step => step.label === "retrieval_evaluated")) {
      add("Business knowledge retrieved", `${record.retrieval_chunk_count} approved source ${record.retrieval_chunk_count === 1 ? "chunk" : "chunks"} supplied for this enquiry. ${record.cited_chunk_ids?.length ?? 0} cited in the decision.`, "knowledge");
      steps[steps.length - 1].sources = sources;
    }
    if (model || record.model_ran) {
      const explanation = typeof model?.detail?.reasonDetail === "string" ? model.detail.reasonDetail : record.reason_detail;
      add("Model decision", explanation ?? `Recorded result: ${humanize(record.reason_code ?? record.status ?? "decision")}. No detailed explanation was saved for this older turn.`,
        "model", record.status === "escalated"||failed ? "attention" : "success");
      steps[steps.length - 1].modelLabel = modelLabel(record.model_provider, record.model_name);
    }
    const check = events.find(step => step.label === "self_check_passed" || step.label === "self_check_escalated");
    if (check) add(check.label === "self_check_passed" ? "Reply checks passed" : "Reply checks requested review",
      typeof check.detail?.reasonDetail === "string" ? check.detail.reasonDetail : humanize(String(check.detail?.reasonCode ?? "grounding and policy checks")),
      "check", check.label === "self_check_passed" ? "success" : "attention");
    if(failed){const failure=replyFailure(record.job_failure_code??record.reason_code);
      add('Reply processing failed',failure.detail+' No completed answer is inferred from this failed attempt.','outcome','attention');
      steps[steps.length-1].modelLabel=modelLabel(record.model_provider,record.model_name);
    }else add(record.status === "escalated" ? "Team review required" : "Assistant handled enquiry",
      record.status === "escalated" ? "The conversation was handed to your team. The assistant stays paused until an authorized release."
        : "The assistant recorded a response. Future customer messages can still be handled in this chat.",
      "outcome", record.status === "escalated" ? "attention" : "success");
  }
  if (record.handoff_intake && record.reply_body) {
    add("Model wrote handoff reply", record.reply_body, "model");
    steps[steps.length - 1].modelLabel = modelLabel(record.intake_provider, record.intake_model);
  }
  if (record.delivery_status) {
    add(record.delivery_status === "sent" ? "Reply delivered" : "Reply delivery",
      record.delivery_status === "sent" ? "The recorded reply reached the customer view." : `Recorded delivery status: ${humanize(record.delivery_status)}.`,
      "delivery", record.delivery_status === "sent" ? "success" : "attention");
  }
  return { id: record.message_id, message: record.body, createdAt: new Date(record.created_at).toISOString(),
    status: failed?'Reply failed':record.ai_paused && !record.trace_id ? "With your team" : record.status === "answered" ? "Answered"
      : record.status === "escalated" ? "Needs attention" : "Awaiting a decision", steps };
}
