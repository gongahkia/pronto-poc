import { CustomerAvatar } from "@/components/customer-avatar";
import { InstagramProfileRefresh } from "@/components/instagram-profile-refresh";
import { customerDisplayName, customerDisplayHandle } from "@/lib/channels/instagram-profile-data";
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
  const contact = customerDisplayName(conversation);
  const handle = customerDisplayHandle(conversation);
  const profile = conversation.channel_kind === "instagram" ? conversation.instagram_profile : undefined;
  const channel = channelDefinition(conversation.channel_kind);

  return (
    <section aria-label="Conversation messages" className="overflow-hidden rounded-lg border border-line bg-panel">
      {conversation.channel_kind === "instagram" && <InstagramProfileRefresh conversationId={conversation.id}
        refreshAfter={conversation.instagram_profile_refresh_after ? new Date(conversation.instagram_profile_refresh_after).toISOString() : undefined} />}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <CustomerAvatar photoUrl={profile?.photoUrl} fallback={channel.iconPath} />
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold">{contact}{profile?.verified && <span className="ml-2 text-xs font-normal text-muted">Verified on Instagram</span>}</p>
          {handle && handle !== contact && <p className="text-sm text-muted">{handle}</p>}
          <p className="text-xs text-muted">{channel.label} conversation</p>
          {profile && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {profile.followerCount !== undefined && <span className="tabular-nums">{profile.followerCount.toLocaleString("en-SG")} followers</span>}
            {profile.followsBusiness === true && <span>Follows you</span>}
            {profile.businessFollowsCustomer === true && <span>You follow this customer</span>}
            {profile.username && <a href={`https://www.instagram.com/${encodeURIComponent(profile.username)}/`} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-10 items-center text-accent underline max-sm:min-h-11">View Instagram profile<span className="sr-only"> (opens in a new tab)</span></a>}
          </div>}
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
