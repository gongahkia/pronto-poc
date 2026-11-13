import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationReviewPanel } from "@/components/conversation-review-panel";
import type { ClientConversationTriage } from "@/lib/dashboard";
import type { Message } from "@/lib/types";

vi.mock("next/image", () => ({
  default: () => null,
}));

const conversation: ClientConversationTriage = {
  id: "conversation_1",
  client_id: "client_1",
  channel_id: "channel_1",
  external_thread_id: "thread_1",
  customer_name: "Alicia",
  customer_handle: "@alicia",
  status: "active",
  last_message_at: new Date("2026-07-06T03:44:00Z"),
  created_at: new Date("2026-07-06T03:43:00Z"),
  deleted_at: null,
  last_message: "Are you open this Sunday?",
  last_sender_role: "customer",
  channel_kind: "whatsapp",
  active_escalation_id: null,
  active_escalation_status: null,
  active_escalation_reason_code: null,
};

const messages: Message[] = [
  {
    id: "message_1",
    conversation_id: "conversation_1",
    client_id: "client_1",
    channel_id: "channel_1",
    external_message_id: "external_1",
    sender_role: "customer",
    body: "Are you open this Sunday?",
    metadata: {},
    created_at: new Date("2026-07-06T03:44:00Z"),
  },
];

describe("ConversationReviewPanel", () => {
  it("shows real messages and channel without fake presence or controls", () => {
    render(<ConversationReviewPanel conversation={conversation} messages={messages} />);

    expect(screen.getByRole("heading", { name: "Messages" })).toBeTruthy();
    expect(screen.getAllByText("Alicia")).toHaveLength(2);
    expect(screen.getByText("WhatsApp conversation")).toBeTruthy();
    expect(screen.getByText("Are you open this Sunday?")).toBeTruthy();
    expect(screen.queryByText("online")).toBeNull();
  });

  it("renders the empty state", () => {
    render(<ConversationReviewPanel conversation={null} messages={[]} />);

    expect(screen.getByText("No conversations yet.")).toBeTruthy();
  });

  it('keeps a staff-review notice visible after an assistant acknowledgement',()=>{
    render(<ConversationReviewPanel conversation={{...conversation,active_escalation_id:'pending-review'}} messages={[
      ...messages,{...messages[0],id:'acknowledgement',sender_role:'agent',body:'Our team will review your refund request.'},
    ]}/>);
    expect(screen.getByRole('status').textContent).toContain('Needs your reply');
    expect(screen.getByRole('status').textContent).toContain('Pronto can answer other supported questions');
  });

  it("places replies in chat bubbles without technical generation labels", () => {
    const reply: Message = { ...messages[0], id: "reply_1", sender_role: "agent", body: "Our team is here to help.",
      metadata: { generationMode: "real", responseProvider: "groq", responseModel: "openai/gpt-oss-20b" } };
    render(<ConversationReviewPanel conversation={conversation} messages={[...messages, reply]} />);

    const incoming = screen.getByText(messages[0].body).closest("li")!;
    const outgoing = screen.getByText(reply.body).closest("li")!;
    expect(incoming.className).toContain("justify-start");
    expect(outgoing.className).toContain("justify-end");
    expect(screen.queryByText(/Real model response|groq|Response details/)).toBeNull();
  });
});
