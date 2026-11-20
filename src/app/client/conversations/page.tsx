import { CustomerAvatar } from "@/components/customer-avatar";
import { customerDisplayName, customerDisplayHandle } from "@/lib/channels/instagram-profile-data";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewBusinessConversation } from "@/lib/staff-permissions";
import { selfServeUIEnabled } from "@/lib/self-serve/settings";
import { getFilteredConversations } from "@/lib/reporting";
import { channelDefinition } from "@/lib/channels/catalog";
import { formatDateTime } from "@/lib/date-format";
import { plainMessageText } from "@/lib/message-text";
import {
  ConversationFilterForm,
  PaginationControls,
  filtersFromSearchParams,
  pageFromSearchParams,
} from "@/components/reporting-panels";
import { AutoRefresh } from "@/components/auto-refresh";
import { SelfServeFrame } from "@/components/self-serve/frame";
import { Header, Badge } from "@/components/self-serve/workspace";
import "@/components/self-serve/self-serve.css";

export const dynamic = "force-dynamic";
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!selfServeUIEnabled()) redirect("/client/inbox");
  const user = await requireUser("client");
  if (!user.clientId) redirect("/access?reason=membership");
  if (!(await canViewBusinessConversation(user, user.clientId)))
    redirect("/access?reason=permission");
  const params = await searchParams;
  const filters = filtersFromSearchParams(params, user.clientId);
  const page = pageFromSearchParams(params),
    limit = 30;
  const conversations = await getFilteredConversations({
    ...filters,
    externalOnly: true,
    sort: "recent",
    limit: limit + 1,
    offset: (page - 1) * limit,
  });
  return (
    <SelfServeFrame allowReadOnly>
      <AutoRefresh intervalMs={10000} />
      <Header
        title="Conversations"
        description="Your customer conversations from connected messaging accounts. Open a thread to review its messages and Pronto’s decisions."
      />
      <section className="ss-panel ss-conversations">
        <ConversationFilterForm
          action="/client/conversations"
          filters={filters}
          includeSimulator={false}
        />
        {conversations.length ? (
          <ol className="ss-conversation-list" aria-label="Saved conversations">
            {conversations.slice(0, limit).map((conversation) => {
              const channel = channelDefinition(conversation.channel_kind);
              const contact = customerDisplayName(conversation);
              const handle = customerDisplayHandle(conversation);
              const attention = Boolean(
                conversation.active_escalation_id ||
                conversation.owner_action_required,
              );
              const status = attention
                ? "Needs attention"
                : conversation.is_resolved
                  ? "Resolved"
                  : "Open";
              return (
                <li key={conversation.id}>
                  <Link href={`/client/conversations/${conversation.id}`}>
                    <CustomerAvatar photoUrl={conversation.channel_kind === "instagram" ? conversation.instagram_profile?.photoUrl : undefined} fallback={channel.iconPath} />
                    <div className="ss-conversation-summary">
                      <div className="ss-conversation-heading">
                        <strong>
                          {contact}
                        </strong>
                        <Badge
                          tone={
                            attention
                              ? "amber"
                              : conversation.is_resolved
                                ? "green"
                                : "blue"
                          }
                        >
                          {status}
                        </Badge>
                      </div>
                      <p className="ss-muted">{handle && handle !== contact ? `${handle} · ` : ""}{channel.label}</p>
                      <p className="ss-conversation-preview">
                        {conversation.last_message
                          ? conversation.last_sender_role === "customer"
                            ? conversation.last_message
                            : plainMessageText(conversation.last_message)
                          : "No messages yet."}
                      </p>
                    </div>
                    <time
                      dateTime={new Date(
                        conversation.last_message_at,
                      ).toISOString()}
                    >
                      {formatDateTime(conversation.last_message_at)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="ss-empty">
            <h2>No conversations found</h2>
            <p>
              Try different filters, or send a customer message to your
              connected account.
            </p>
          </div>
        )}
        <PaginationControls
          action="/client/conversations"
          searchParams={params}
          page={page}
          hasNext={conversations.length > limit}
        />
      </section>
    </SelfServeFrame>
  );
}
