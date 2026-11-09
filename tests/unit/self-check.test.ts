import { describe, expect, it } from "vitest";
import { evaluatePostGenerationSelfCheck } from "@/lib/agent/self-check";
import type { GroundedAnswerDecision } from "@/lib/llm/types";
import type { KnowledgeChunk } from "@/lib/types";
import { reservationClarificationContext, type ReservationModelContext } from "@/lib/reservations/model-context";

describe("post-generation self-check", () => {
  it("passes a cited answer grounded in retrieved source text", () => {
    const result = evaluatePostGenerationSelfCheck({
      decision: answerDecision({
        answer:
          "Reservations are available for tables of 1 to 6 guests for lunch or dinner.",
        citedChunkIds: ["chunk-1"],
      }),
      retrievedChunks: [
        chunk(
          "chunk-1",
          "Reservations: Tables for 1 to 6 guests can be reserved for lunch or dinner.",
        ),
      ],
    });

    expect(result).toMatchObject({
      passed: true,
      reasonCode: "post_check_passed",
    });
  });

  it("fails answers that cite chunks outside the retrieval set", () => {
    const result = evaluatePostGenerationSelfCheck({
      decision: answerDecision({
        answer: "Saturday and Sunday opening hours are 10:00 AM to 10:00 PM.",
        citedChunkIds: ["missing-chunk"],
      }),
      retrievedChunks: [
        chunk("chunk-1", "Saturday and Sunday: 10:00 AM to 10:00 PM."),
      ],
    });

    expect(result).toMatchObject({
      passed: false,
      reasonCode: "post_check_invalid_citations",
    });
  });

  it("fails answers that promise unsupported business mutations", () => {
    const result = evaluatePostGenerationSelfCheck({
      decision: answerDecision({
        answer:
          "We have cancelled your reservation and your booking is now confirmed as cancelled.",
        citedChunkIds: ["chunk-1"],
      }),
      retrievedChunks: [
        chunk("chunk-1", "Reservation changes must be handled by the restaurant team."),
      ],
    });

    expect(result).toMatchObject({
      passed: false,
      reasonCode: "post_check_forbidden_mutation",
    });
  });

  it("passes a cited Mandarin answer with source overlap", () => {
    const result = evaluatePostGenerationSelfCheck({
      decision: answerDecision({
        answer: "周六和周日营业时间是上午10点到晚上10点。",
        citedChunkIds: ["chunk-1"],
      }),
      retrievedChunks: [
        chunk("chunk-1", "Mandarin opening-hours phrasing: 周六和周日营业时间是上午10点到晚上10点."),
      ],
    });

    expect(result.passed).toBe(true);
  });
  it.each(["We can't guarantee the pasta is safe. Our team must verify ingredients for allergies.",
    "We cannot guarantee the pasta is safe. Our team must verify ingredients for allergies."])("allows a refusal to make a safety guarantee: %s", answer => {
    expect(evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", "Our team must verify ingredients and suitability for allergies.")] }).passed).toBe(true);
  });
  it.each(["We guarantee the pasta is safe.", "The pasta is guaranteed safe.", "We cannot guarantee the pasta, but we guarantee the dessert is safe."])("still blocks an affirmative guarantee: %s", answer => {
    expect(evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", "Our team must verify ingredients and suitability for allergies.")] }).reasonCode).toBe("post_check_forbidden_mutation");
  });
  it.each(["We'll refund your order.", "We can cancel your booking.", "Your refund will be approved."])("blocks promised future mutations too: %s", answer => {
    expect(evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", "The team must review refund and booking requests.")] }).reasonCode).toBe("post_check_forbidden_mutation");
  });
  it("accepts translated hours with supported values while rejecting a wrong translated time", () => {
    const check = (answer: string) => evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", "Opening time is 10:00am; standard close time is 10:00pm daily.")] });
    expect(check("我们每天上午10:00开门，晚上10:00关门。").passed).toBe(true);
    expect(check("我们每天上午10:00开门，晚上8:00关门。").passed).toBe(false);
    expect(check("今天餐厅提供免费的无限量宴会。").passed).toBe(false);
  });
  it("checks Malay translated hours against the original values", () => {
    const check = (answer: string) => evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", "Opening time is 10:00am; standard close time is 10:00pm daily.")] });
    expect(check("Restoran dibuka pada 10 pagi dan ditutup pada 10 malam setiap hari.").passed).toBe(true);
    expect(check("Restoran dibuka pada 10 pagi dan ditutup pada 8 malam setiap hari.").passed).toBe(false);
  });
  it("permits rejecting a customer-supplied wrong value only alongside a sourced replacement", () => {
    const check = (answer: string) => evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      customerContext: "You close at 8pm, right?", retrievedChunks: [chunk("chunk-1", "Our standard closing time is 10:00pm daily.")] });
    expect(check("Our standard closing time is 10:00pm, not 8:00pm.").passed).toBe(true);
    expect(check("Our standard closing time is 8:00pm.").passed).toBe(false);
    expect(check("Our standard closing time is 7:00pm, not 8:00pm.").passed).toBe(false);
  });
  it("grounds a missing-party clarification in the permitted booking workflow", () => {
    const context = { metadata: { requiresStaff: false, request: { date: "2026-11-10", time: "19:00", partySize: null } } } as unknown as ReservationModelContext;
    const answer = "How many people will be dining?";
    expect(evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", 'Booking request: {"date":"2026-11-10","time":"19:00","partySize":null}')],
      ...reservationClarificationContext(answer, context) }).passed).toBe(true);
  });
  it("allows AM/PM alternatives only for the customer's own ambiguous hour in a question", () => {
    const context = { metadata: { requiresStaff: false, request: { date: "2026-11-10", time: null, partySize: 2 } } } as unknown as ReservationModelContext;
    const check = (answer: string) => evaluatePostGenerationSelfCheck({ decision: answerDecision({ answer, citedChunkIds: ["chunk-1"] }),
      retrievedChunks: [chunk("chunk-1", 'Booking request: {"date":"2026-11-10","time":null,"partySize":2,"ambiguousTimeOptions":["07:00","19:00"]}')],
      ...reservationClarificationContext(answer, context) });
    expect(check("Did you mean 7:00 am or 7:00 pm?").passed).toBe(true);
    expect(check("Did you mean 8:00 am or 8:00 pm?").passed).toBe(false);
    expect(check("Your booking is confirmed for 7:00 pm.").passed).toBe(false);
    expect(reservationClarificationContext("Did you mean 7am?", { ...context, metadata: { ...context.metadata, requiresStaff: true } })).toBeNull();
  });
});

function answerDecision(
  overrides: Partial<GroundedAnswerDecision>,
): GroundedAnswerDecision {
  return {
    action: "answer",
    answer: null,
    citedChunkIds: [],
    reasonCode: "grounded_answer",
    reasonDetail: "Answered from retrieved knowledge.",
    confidence: 0.92,
    ...overrides,
  };
}

function chunk(id: string, content: string): KnowledgeChunk {
  return {
    id,
    source_id: "source-1",
    client_id: "client-1",
    chunk_index: 0,
    content,
    token_estimate: 20,
    metadata: {},
  };
}

it('accepts a Tamil staff-review acknowledgement while retaining factual and citation checks',()=>{
 const body='இந்த விவரத்தை எங்கள் குழு பரிசீலிக்கும்.';
 const input={decision:answerDecision({answer:body,citedChunkIds:[]}),retrievedChunks:[],clarificationContext:'Our team will review this enquiry. The assistant is paused.',requireQuestion:false};
 expect(evaluatePostGenerationSelfCheck(input).passed).toBe(true);
 expect(evaluatePostGenerationSelfCheck({...input,decision:answerDecision({answer:body+' The refund is S$50.',citedChunkIds:[]})}).passed).toBe(false);
 expect(evaluatePostGenerationSelfCheck({...input,decision:answerDecision({answer:body,citedChunkIds:['invented']})}).passed).toBe(false);
 expect(evaluatePostGenerationSelfCheck({...input,decision:answerDecision({answer:body+' Your refund has been processed.',citedChunkIds:[]})}).passed).toBe(false);
});

it('keeps a Chinese allergy disclaimer and staff acknowledgement while rejecting a positive guarantee',()=>{
 const context='我有严重花生过敏，请保证食物绝对安全。 Our team will review this enquiry. The assistant is paused.';
 for(const answer of ['我们无法在此保证食物绝对安全；我们的团队会跟进。','我们的团队会审核您的咨询并协助您。']){
  expect(evaluatePostGenerationSelfCheck({decision:answerDecision({answer,citedChunkIds:[]}),retrievedChunks:[],clarificationContext:context,requireQuestion:false}).passed).toBe(true);
 }
 expect(evaluatePostGenerationSelfCheck({decision:answerDecision({answer:'我们的团队保证食物绝对安全。',citedChunkIds:[]}),retrievedChunks:[],clarificationContext:context,requireQuestion:false}).passed).toBe(false);
});

it('accepts an attributed booking request in a staff acknowledgement without inventing a time',()=>{
 const answer='Our team will review your request for a table for two tomorrow at 7:00 pm and your peanut-safety question. We can’t guarantee the kitchen is peanut-free; please wait for our team to confirm before relying on it.';
 const input={decision:answerDecision({answer,citedChunkIds:[]}),retrievedChunks:[],clarificationContext:'Find a table for 2 tomorrow at 7pm and guarantee the kitchen has no peanuts. Our team will review this enquiry.',requireQuestion:false};
 expect(evaluatePostGenerationSelfCheck(input).passed).toBe(true);
 expect(evaluatePostGenerationSelfCheck({...input,decision:answerDecision({answer:answer.replace('7:00 pm','8:00 pm'),citedChunkIds:[]})}).passed).toBe(false);
 expect(evaluatePostGenerationSelfCheck({...input,decision:answerDecision({answer:answer+' Your booking is confirmed.',citedChunkIds:[]})}).passed).toBe(false);
});

it('distinguishes an explicit conditional Chope referral from a completed or promised transaction',()=>{
 const source=chunk('chope','Complete and confirm your booking on Chope. No booking has been made.');
 const check=(answer:string)=>evaluatePostGenerationSelfCheck({decision:answerDecision({answer,citedChunkIds:['chope']}),retrievedChunks:[source]});
 expect(check('Your booking is confirmed only after you complete it on Chope.').passed).toBe(true);
 expect(check('Your booking is confirmed.').passed).toBe(false);
 expect(check('Your refund is confirmed only after you complete it on Chope.').passed).toBe(false);
 expect(check('Your booking is confirmed only after you complete it on Chope. We have booked your table.').passed).toBe(false);
});
