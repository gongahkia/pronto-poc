import Image from "next/image";
import type { ReactNode } from "react";
import { channelDefinition } from "@/lib/channels/catalog";
import { formatDateTime } from "@/lib/date-format";
import type { ClientConversationTriage } from "@/lib/dashboard";
import type { Message } from "@/lib/types";
import { Badge } from "@/components/badge";
import { ChatHistory } from "@/components/chat-history";
import { MessageText } from "@/components/message-text";

export function ChannelConversationThread({
  conversation,
  messages,
  footer,
}: {
  conversation: ClientConversationTriage;
  messages: Message[];
  footer?: ReactNode;
}) {
  const contact = conversation.customer_name ?? conversation.customer_handle ?? "Customer";
  const channel = channelDefinition(conversation.channel_kind);

  return (
    <section aria-label="Conversation messages" className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Image src={channel.iconPath} alt="" width={22} height={22} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{contact}</p>
          <p className="text-xs text-muted">{conversation.channel_kind === "console" ? "Instagram" : channel.label} conversation</p>
        </div>
        <Badge tone={conversation.active_escalation_id ? "amber" : "neutral"}>
          {conversation.active_escalation_id ? "Needs attention" : conversation.status}
        </Badge>
      </div>
      {conversation.active_escalation_id && <p role="status" className="border-b border-line bg-warning-bg px-4 py-3 text-sm">Needs your reply. {conversation.status === "active" ? "Pronto can answer other supported questions; this issue stays open for your team." : "AI replies are paused while your team handles this conversation."}</p>}
      <ChatHistory lastMessageId={messages.at(-1)?.id}>
      {messages.length ? (
        <ol className="space-y-4" aria-label="Message history">
          {messages.map((message) => {
            const fromCustomer = message.sender_role === "customer";
            const sender = fromCustomer
              ? contact
              : message.sender_role === "agent"
                ? "Pronto assistant"
                : message.sender_role === "operator"
                  ? "Your team"
                  : "System";
            return (
              <li key={message.id} className={`flex ${fromCustomer ? "justify-start" : "justify-end"}`}>
                <div className={`min-w-0 max-w-[86%] rounded-2xl px-4 py-3 ${fromCustomer
                  ? "rounded-tl-md border border-line bg-surface"
                  : "rounded-tr-md bg-accent text-white"}`}>
                  <p className="mb-1 text-xs font-semibold opacity-75">{sender}</p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6"><MessageText text={message.body} fromCustomer={fromCustomer} /></p>
                  <time dateTime={new Date(message.created_at).toISOString()} className="mt-2 block text-right text-[11px] opacity-70">
                    {formatDateTime(message.created_at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="p-5 text-sm text-muted">No messages in this conversation yet.</p>
      )}
      </ChatHistory>
      {footer}
    </section>
  );
}
