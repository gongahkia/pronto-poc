import { getFilteredConversations } from "@/lib/reporting";
import { customerDisplayName, customerDisplayHandle } from "@/lib/channels/instagram-profile-data";

export type HandoverSummary = {
  items: { id: string; customer: string; handle: string | null; channel: string;
    reason: string; paused: boolean; updatedAt: string }[];
  hasMore: boolean;
};

export function handoverReason(code: string | null): string {
  const reasons: Record<string, string> = {
    knowledge_conflict: "Business rules conflict",
    selfserve_handover: "Matches your handover settings",
    human_handoff_requested: "Customer asked for a person",
    unsupported_media: "Message needs a person to review it",
    low_confidence: "Not enough reliable information",
    no_knowledge: "Not covered by business knowledge",
    no_relevant_knowledge: "Not covered by business knowledge",
    transactional_action: "Action requires your team",
    complaint_or_refund: "Complaint or refund enquiry",
    urgent_or_negative_sentiment: "Customer concern needs attention",
  };
  return code && Object.prototype.hasOwnProperty.call(reasons, code) ? reasons[code] : "Your team needs to review this enquiry";
}

export async function getHandoverSummary(clientId: string): Promise<HandoverSummary> {
  const rows = await getFilteredConversations({ clientId, externalOnly: true,
    status: "needs_reply", sort: "attention", limit: 11 });
  return {
    items: rows.slice(0, 10).map(row => ({ id: row.id,
      customer: customerDisplayName(row), handle: customerDisplayHandle(row),
      channel: row.channel_kind, reason: handoverReason(row.active_escalation_reason_code),
      paused: row.status === "escalated" || row.ai_should_respond === false,
      updatedAt: new Date(row.last_message_at).toISOString() })),
    hasMore: rows.length > 10,
  };
}
