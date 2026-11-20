import {selfServeUIEnabled} from '@/lib/self-serve/settings';
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { canViewBusinessConversation } from "@/lib/staff-permissions";
import { redirect } from "next/navigation";
import { getClient } from "@/lib/dashboard";
import {
  getClientDashboardAnalytics,
  getFilteredConversations,
} from "@/lib/reporting";
import { AppShell } from "@/components/shell";
import {
  ConversationFilterForm,
  ConversationList,
  PaginationControls,
  filtersFromSearchParams,
  pageFromSearchParams,
} from "@/components/reporting-panels";
import { Badge } from "@/components/badge";
import { AutoRefresh } from "@/components/auto-refresh";

export default async function ClientInboxPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("client");
  if(selfServeUIEnabled())redirect("/client/home");
  if (!user.clientId) {
    redirect("/access?reason=membership");
  }
  if (!await canViewBusinessConversation(user, user.clientId)) redirect("/access?reason=permission");

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filters = filtersFromSearchParams(resolvedSearchParams, user.clientId);
  const page = pageFromSearchParams(resolvedSearchParams);
  const sort = resolvedSearchParams.sort === "recent" ? "recent" : "attention";
  const viewHref = (changes: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(resolvedSearchParams)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first && key !== "page") params.set(key, first);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    return `/client/inbox${params.size ? `?${params}` : ""}`;
  };
  const limit = 75;
  const [client, conversations, analytics] = await Promise.all([
    getClient(user.clientId),
    getFilteredConversations({ ...filters, sort, limit: limit + 1, offset: (page - 1) * limit }),
    getClientDashboardAnalytics(user.clientId),
  ]);
  if (!client) {
    throw new Error("Client record not found.");
  }

  const hasNext = conversations.length > limit;
  const visibleConversations = conversations.slice(0, limit);

  return (
    <AppShell user={user} active="client" clientActive="inbox" workspaceName={client.name} workspaceProfile={client.business_profile}>
      <AutoRefresh intervalMs={3000}/>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-muted">
            Customer conversations, team follow-ups and recent replies.
          </p>
        </div>
        <Badge tone={analytics.actionableEscalations ? "amber" : "green"}>
          {analytics.actionableEscalations} need reply
        </Badge>
      </div>

      <section className="ui-panel">
        <div className="ui-panel-header">
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" aria-label="Inbox views">
            <QuickFilter href={viewHref({ status: "" })} label="All" active={!filters.status} />
            <QuickFilter
              href={viewHref({ status: "needs_reply" })}
              label="Needs attention"
              active={filters.status === "needs_reply"}
            />
            <QuickFilter
              href={viewHref({ status: "closed" })}
              label="Resolved"
              active={filters.status === "closed"}
            />
          </div>
          <div className="flex gap-3 text-sm">
            <Link href={viewHref({ sort: "" })} aria-current={sort === "attention" ? "page" : undefined}
              className={sort === "attention" ? "font-medium text-accent" : "text-muted"}>Needs attention first</Link>
            <Link href={viewHref({ sort: "recent" })} aria-current={sort === "recent" ? "page" : undefined}
              className={sort === "recent" ? "font-medium text-accent" : "text-muted"}>Most recent</Link>
          </div>
          </div>
        </div>
        <ConversationFilterForm
          action="/client/inbox"
          filters={{ ...filters, sort }}
        />
        <ConversationList
          conversations={visibleConversations}
          hrefForConversation={(conversation) => `/client/conversations/${conversation.id}`}
          emptyText="No conversations match these filters."
          ctaLabel="Open"
        />
        <PaginationControls
          action="/client/inbox"
          searchParams={resolvedSearchParams}
          page={page}
          hasNext={hasNext}
        />
      </section>
    </AppShell>
  );
}

function QuickFilter({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        active
          ? "bg-accent text-white"
          : "border border-line bg-surface text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}
