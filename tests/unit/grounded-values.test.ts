import { describe, expect, it } from "vitest";
import { evaluatePostGenerationSelfCheck } from "@/lib/agent/self-check";
import { unsupportedGroundedValue } from "@/lib/agent/grounded-values";

function check(source: string, answer: string, customerContext?: string) {
  return unsupportedGroundedValue({ answer, customerContext, citedChunks: [{
    id: "source-1", source_id: "document-1", client_id: "tenant-1", chunk_index: 0,
    content: source, token_estimate: 20, metadata: {},
  }] });
}

describe("business facts against cited evidence", () => {
  it.each([
    ["We close at 10pm.", "We close at 11pm.", false],
    ["We close at 22:00.", "We close at 10pm.", true],
    ["We close at 10:00 PM.", "We close at 22:00.", true],
    ["We open at 10:00am.", "We open at 10.00am.", true],
    ["We open at 10:00am.", "We open at 11.00am.", false],
    ["We open at 10:00am.", "We open at 10.99am.", false],
    ["We open at 10:00am.", "Kami buka pada 10.00 pagi.", true],
    ["We open at 10:00am.", "我们上午10.00开门。", true],
    ["We open at 10:00am.", "காலை 10.00 மணி திறக்கும்.", true],
    ["Coffee costs S$10.00.", "We open at 10.00am.", false],
    ["Hours: 10am–10pm.", "We open at 10am and close at 10pm.", true],
    ["We open at 10am and close at 10pm.", "We close at 10am.", false],
    ["We open until 10pm.", "We close at 10pm.", true],
    ["The price is S$12.50.", "The price is S$15.20.", false],
    ["The price is SGD 12.50.", "It costs S$12.5.", true],
    ["The price is SGD 12.50.", "It costs $12.50.", true],
    ["The price is SGD 12.50.", "It costs USD 12.50.", false],
    ["Coffee costs S$6; cake costs S$8.", "Coffee costs S$8.", false],
    ["Coffee costs S$6; cake costs S$8.", "Cake costs S$8.", true],
    ["Coffee costs S$6; cake costs S$8.", "It costs S$8.", false],
    ["Promotion ends 31 December.", "Promotion ends 31 December 2026.", false],
    ["Promotion ends 31 December 2026.", "Promotion ends 31 December.", true],
    ["We close at 10pm.", "We close at 25pm.", false],
    ["We close at 10pm.", "We close at 25:00.", false],
    ["We close at 10pm.", "We close at 10:99pm.", false],
    ["We open at 10am and close at 10pm.", "我们上午10点关门。", false],
    ["We open at 10am and close at 10pm.", "Kami tutup pada 10 pagi.", false],
    ["The date is 2026-11-12.", "The date is 12 November 2026.", true],
    ["The date is 2026-11-12.", "The date is November 13, 2026.", false],
    ["The date is 12/11/2026.", "The date is 13/11/2026.", false],
    ["Book at https://www.chope.co/restaurant/demo?time=19%3A00", "Book at https://www.chope.co/restaurant/demo?time=20%3A00", false],
    ["Book at https://www.chope.co/restaurant/demo", "Book at https://evil.example/restaurant/demo", false],
    ["Book at https://www.chope.co/restaurant/demo", "Book at https://www.chope.co/restaurant/demo.", true],
    ["Book at https://www.chope.co/restaurant/demo", "Book at http://www.chope.co/restaurant/demo", false],
    ["Hours: 10am–10pm.", "Could you confirm your preferred 11pm time?", true, "I would like 11pm."],
    ["Hours: 10am–10pm.", "We close at 11pm.", false, "I would like 11pm."],
    ["Hours: 10am–10pm.", "We close at 11pm. Can you confirm?", false, "I would like 11pm."],
    ["Date: 2026-02-28.", "Date: 2026-02-30.", false],
    ["Our team will review your enquiry.", "Please use https://evil.example/ to continue.", false, "My URL is https://evil.example/"],
    ["Closing is at 22:00.", "晚上10点关门。", true],
    ["Closing is at 22:00.", "Kami tutup pada 10:00 malam.", true],
  ])("validates %s against %s", (source: string, answer: string, passed: boolean, context?: string) => {
    expect(check(source, answer, context) === null).toBe(passed);
  });

  it("rejects the formerly passing 10pm/11pm contradiction through the public self-check", () => {
    const result = evaluatePostGenerationSelfCheck({ decision: { action: "answer", answer: "Our outlet closes at 11pm.",
      confidence: 0.99, reasonCode: "grounded_answer", reasonDetail: "Cited reply", citedChunkIds: ["hours"] },
    retrievedChunks: [{ id: "hours", source_id: "hours", client_id: "client", chunk_index: 0,
      content: "Our outlet closes at 10pm.", token_estimate: 10, metadata: {} }] });
    expect(result).toMatchObject({ passed: false, reasonCode: "post_check_unsupported_fact" });
  });
});
