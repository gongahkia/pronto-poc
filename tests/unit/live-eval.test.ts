import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveEvalBudget, requestCostBound } from "../../scripts/live-eval-budget";
import { gradeLiveTurn, evaluationDate } from "@/lib/evals/live-quality";
import { businessClock } from "@/lib/agent/business-clock";
import { chopeDateMatches } from "@/lib/reservations/chope-browser";
import { liveCustomerCases } from "../../evals/live-customer-cases";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
describe("bounded live evaluation", () => {
  it("accepts Chope date padding variations while retaining the exact requested calendar date", () => {
    expect(chopeDateMatches("9-11-2026", "2026-11-09")).toBe(true);
    expect(chopeDateMatches("09-11-2026", "2026-11-09")).toBe(true);
    expect(chopeDateMatches("9-1-2027", "2027-01-09")).toBe(true);
    expect(chopeDateMatches("8-11-2026", "2026-11-09")).toBe(false);
    expect(chopeDateMatches("11-9-2026", "2026-11-09")).toBe(false);
    expect(chopeDateMatches("2026-11-09", "2026-11-09")).toBe(false);
  });
  it("uses the business timezone across a UTC date boundary and handles invalid configuration", () => {
    const now = new Date("2026-11-08T17:00:00Z");
    expect(businessClock({ timezone: "Asia/Singapore" }, now)).toBe("2026-11-09 01:00 (Asia/Singapore)");
    expect(businessClock({ timezone: "invalid" }, now)).toBe("2026-11-08 17:00 (UTC)");
  });
  it("anchors Chope dates independently of the machine timezone", () => {
    const now = new Date("2026-11-08T17:00:00Z");
    expect(evaluationDate("tomorrow", now)).toBe("2026-11-10");
    expect(evaluationDate("day_after_tomorrow", now)).toBe("2026-11-11");
    expect(evaluationDate("upcoming_friday", now)).toBe("2026-11-13");
  });
  it("checks booking URL parameters rather than merely looking for a Chope hostname", () => {
    const expected = { outcome: "answered" as const, bookingLink: true, reservation: { partySize: 4, time: "20:00" } };
    const actual = { outcome: "answered", answer: "https://www.chope.co/singapore-restaurants/restaurant/ps-cafe-raffles-city?adults=2&children=0&time=7%3A00+pm",
      ownership: "active", delivered: true, citations: ["tool"], modelCalls: 1, reservationRequest: { partySize: 4, time: "20:00" } };
    expect(gradeLiveTurn(expected, actual)).toContain("The booking link does not preserve the requested outlet/date/time/party.");
    expect(gradeLiveTurn(expected, { ...actual, answer: actual.answer.replace("adults=2", "adults=4").replace("7%3A00", "8%3A00") })).toEqual([]);
  });
  it("reserves before calls, carries uncertain charges across runs and stops at the cumulative cap", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pronto-live-budget-")); folders.push(folder);
    const path = join(folder, "budget.json");
    const first = new LiveEvalBudget(path);
    // Roughly US$3 is reserved, leaving insufficient budget for the next call.
    await first.reserve("x".repeat(6_000_000), 1000);
    const resumed = new LiveEvalBudget(path);
    expect((await resumed.summary()).uncertainRequests).toBe(1);
    await expect(resumed.reserve("x".repeat(6_000_000), 1000)).rejects.toThrow(/budget is exhausted/);
    expect((await resumed.summary()).requests).toBe(1);
  });
  it("settles provider-reported output once without double-counting reasoning", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pronto-live-usage-")); folders.push(folder);
    const budget = new LiveEvalBudget(join(folder, "budget.json"));
    const id = await budget.reserve("{}", 2000);
    await budget.settle(id, { input_tokens: 1000, output_tokens: 1000 });
    expect((await budget.summary()).accountedUsd).toBeCloseTo(0.000825);
    expect(() => requestCostBound("{}", 100000)).toThrow(/output limit/);
  });
  it("fails wrong facts even when routing, citations and delivery look correct", () => {
    const observed = { outcome: "answered", answer: "We close at 8pm.", ownership: "active", citations: ["valid"], delivered: true, modelCalls: 1 };
    expect(gradeLiveTurn({ outcome: "answered", facts: ["time:22:00"] }, observed)).toContain("Missing or incorrect factual value: time:22:00");
    expect(gradeLiveTurn({ outcome: "skipped" }, observed)).toContain("The assistant replied during human ownership.");
  });
  it("accepts a contracted unavailable response while rejecting an affirmative availability claim", () => {
    const expected = liveCustomerCases.find(item => item.id === "unavailable-slot")!.turns[0].expect;
    const actual = { outcome: "answered", answer: "A table wasn’t available when checked. Please check chope.co.",
      ownership: "active", citations: ["chope-source"], delivered: true, modelCalls: 2 };
    expect(gradeLiveTurn(expected, actual)).toEqual([]);
    expect(gradeLiveTurn(expected, { ...actual, answer: "7pm is available. Please check chope.co." })).not.toEqual([]);
  });
  it("accepts a clear request for missing details without requiring a question mark", () => {
    const observed = { outcome: "answered", answer: "Please share your date, time and party size.",
      ownership: "active", citations: ["tool-context"], delivered: true, modelCalls: 1 };
    expect(gradeLiveTurn({ outcome: "answered", question: true }, observed)).toEqual([]);
    expect(gradeLiveTurn({ outcome: "answered", question: true }, { ...observed, answer: "You can book on Chope." })).not.toEqual([]);
  });
  it("rejects wrong tool arguments even when the answer looks like a valid booking referral", () => {
    const observed = { outcome: "answered", answer: "Please check and confirm your booking on Chope.", ownership: "active",
      citations: ["tool-context"], delivered: true, modelCalls: 2, reservationRequest: { partySize: 2, time: "19:00" } };
    expect(gradeLiveTurn({ outcome: "answered", reservation: { partySize: 4, time: "20:00" } }, observed))
      .toEqual(["Incorrect reservation partySize.", "Incorrect reservation time."]);
  });
});
