import { describe, expect, it } from "vitest";
import { normalizeKnowledgeQuery } from "@/lib/knowledge/query";

describe("knowledge query normalization", () => {
  it("boosts obvious opening-hours language", () => {
    const normalized = normalizeKnowledgeQuery("What time does the shop open?");

    expect(normalized.categories).toContain("opening_hours");
    expect(normalized.embeddingText).toContain("opening hours");
    expect(normalized.embeddingText).toContain("operating hours");
    expect(normalized.searchQuery).toContain("time");
    expect(normalized.searchQuery).toContain("opening");
    expect(normalized.searchQuery).toContain("hours");
  });

  it("maps Sunday availability questions to opening hours", () => {
    const normalized = normalizeKnowledgeQuery("Are you open this Sunday?");

    expect(normalized.categories).toEqual(["opening_hours"]);
    expect(normalized.searchQuery).toContain("sunday");
    expect(normalized.searchQuery).toContain("weekend");
  });

  it("does not add business-fact aliases for unrelated text", () => {
    const normalized = normalizeKnowledgeQuery("Tell me something interesting.");

    expect(normalized.categories).toEqual([]);
    expect(normalized.embeddingText).toBe("Tell me something interesting.");
  });
  it.each(["wat tym u opn n cls?", "Pukul berapa tutup?", "எத்தனை மணிக்கு திறக்கும், மூடும்?"])("retrieves hours for informal and supported translated wording: %s", message => {
    expect(normalizeKnowledgeQuery(message).categories).toContain("opening_hours");
    expect(normalizeKnowledgeQuery(message).searchQuery).toContain("hours");
  });
});
