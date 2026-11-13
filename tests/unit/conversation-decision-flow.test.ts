import { describe, expect, it } from "vitest";
import { buildConversationDecision, type DecisionRecord } from "@/lib/conversation-decision-flow";

const record: DecisionRecord = { message_id: "customer-1", body: "What time do you close?", created_at: "2026-10-26T05:00:00Z",
  ai_paused: false, trace_id: "trace", status: "answered", reason_code: "business_hours", reason_detail: null,
  retrieval_chunk_count: 2, cited_chunk_ids: ["hours"], steps: [{ label: "retrieval_evaluated" }], model_ran: true,
  reply_body: "We close at 10pm.", handoff_intake: false, delivery_status: "sent", job_status: "completed",
  model_provider: "groq", model_name: "openai/gpt-oss-20b",
  sources: [{ chunkId: "hours", sourceId: "source-1", title: "Opening hours", url: "https://example.com/hours", excerpt: "10am to 10pm.", version: null, snapshot: false },
    { chunkId: "menu", sourceId: "source-2", title: "Menu", url: null, excerpt: "Food and drinks.", version: null, snapshot: false }] };

describe("recorded conversation decision flow", () => {
  it('shows a failed provider attempt as failed, without claiming the enquiry was handled',()=>{
    const result=buildConversationDecision({...record,status:'failed',reason_code:'output_truncated',job_status:'dead',model_ran:false,steps:[],delivery_status:null});
    expect(result.status).toBe('Reply failed');
    expect(result.steps.find(step=>step.title==='Reply processing failed')?.description).toMatch(/ended before/);
    expect(result.steps.some(step=>step.title==='Assistant handled enquiry')).toBe(false);
  });
  it("shows actual retrieved documents, separates citations from context, and names the recorded model", () => {
    const result = buildConversationDecision(record);
    expect(result.steps.find(step => step.kind === "knowledge")?.sources).toMatchObject([
      { title: "Opening hours", cited: true }, { title: "Menu", cited: false },
    ]);
    expect(result.steps.find(step => step.title === "Model decision")?.modelLabel).toBe("Groq · openai/gpt-oss-20b");
    expect(result.steps.at(-1)?.title).toBe("Reply delivered");
  });

  it("preserves captured source names and excerpts after the live document changes", () => {
    const result = buildConversationDecision({ ...record, steps: [{ label: "knowledge_context", detail: { sources: [
      { ...record.sources![0], title: "Hours at decision time", excerpt: "Original approved hours", snapshot: true },
    ] } }, { label: "model_decision", detail: { reasonDetail: "The approved source provides standard daily closing hours." } }] });
    expect(result.steps.find(step => step.kind === "knowledge")?.sources?.[0]).toMatchObject({
      title: "Hours at decision time", excerpt: "Original approved hours", snapshot: true, cited: true,
    });
    expect(result.steps.find(step => step.title === "Model decision")?.description).toBe("The approved source provides standard daily closing hours.");
  });

  it("distinguishes a routing rule from the separate model-written handoff acknowledgement", () => {
    const result = buildConversationDecision({ ...record, model_ran: false, status: "escalated", reason_code: "complaint_or_refund",
      reason_detail: "Staff must review refund requests.", steps: [{ label: "pre_generation_escalated" }],
      retrieval_chunk_count: 0, handoff_intake: true, intake_provider: "groq", intake_model: "openai/gpt-oss-20b" });
    expect(result.steps.some(step => step.title === "Routing rule matched")).toBe(true);
    expect(result.steps.some(step => step.title === "Model decision")).toBe(false);
    expect(result.steps.find(step => step.title === "Model wrote handoff reply")?.modelLabel).toContain("Groq");
  });

  it("does not invent model decisions for customer follow-ups while staff owns a thread", () => {
    const result = buildConversationDecision({ ...record, ai_paused: true, trace_id: null, model_ran: false,
      reply_body: null, delivery_status: null });
    expect(result.status).toBe("With your team");
    expect(result.steps.map(step => step.title)).toEqual(["Customer message", "Assistant paused"]);
  });

  it("does not invent a successful decision when no trace was saved", () => {
    const result = buildConversationDecision({ ...record, trace_id: null, model_ran: false, job_status: "failed", delivery_status: null });
    expect(result.steps.at(-1)?.title).toBe("Reply processing failed");
    expect(result.status).toBe('Reply failed');
  });
});

it("keeps source citations attached to retrieval when a Chope tool check precedes it", () => {
 const result=buildConversationDecision({...record,steps:[{label:"chope_availability_checked",detail:{status:"available",observedAt:"2026-10-26T07:00:00Z",request:{date:"2026-10-31",time:"19:00",partySize:4}}},{label:"retrieval_evaluated"}]});
 expect(result.steps.find(step=>step.title==="Chope availability checked")).toMatchObject({kind:"check",tone:"success"});
 expect(result.steps.find(step=>step.kind==="knowledge")).toMatchObject({title:"Business knowledge retrieved",sources:expect.arrayContaining([expect.objectContaining({chunkId:"hours",cited:true})])});
});
