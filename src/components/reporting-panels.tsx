import { ArrowRight, CheckCircle2, ChevronDown, Filter, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type {
  ClientDashboardAnalytics,
  ConversationFilterInput,
  FilteredConversation,
} from "@/lib/reporting";
import { channelDefinition, channelDefinitions } from "@/lib/channels/catalog";
import { Badge } from "@/components/badge";
import { StatCard } from "@/components/stat-card";
import { formatDateTime } from "@/lib/date-format";
import { plainMessageText } from "@/lib/message-text";

export function ClientAnalyticsCards({
  analytics,
}: {
  analytics: ClientDashboardAnalytics;
}) {
  return (
    <section className="grid gap-4 md:grid-cols-6">
      <StatCard label="Conversations" value={analytics.conversationCount} />
      <StatCard
        label="Escalation rate"
        value={`${Math.round(analytics.escalationRate * 100)}%`}
        hint={`${analytics.escalatedConversationCount} escalated`}
      />
      <StatCard label="Open triage" value={analytics.actionableEscalations} />
      <StatCard
        label="First response"
        value={formatDuration(analytics.avgFirstResponseSeconds)}
      />
      <StatCard
        label="CSAT"
        value={analytics.csatAverage ? analytics.csatAverage.toFixed(1) : "Pending"}
        hint={`${analytics.csatResponses} responses`}
      />
    </section>
  );
}

export function ConversationFilterForm({
  action,
  filters,
}: {
  action: string;
  filters: ConversationFilterInput;
}) {
  return (
    <form action={action} className="space-y-3 border-b border-line p-4">
      {filters.sort && <input type="hidden" name="sort" value={filters.sort}/>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <div className="relative min-w-0">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"/>
          <input name="q" type="search" aria-label="Search conversations" defaultValue={filters.query ?? ""}
            className="ui-input w-full min-w-0 py-2 pl-9 pr-3 text-sm" placeholder="Search customer or message"/>
        </div>
        <select name="channel" aria-label="Channel" defaultValue={filters.channelKind ?? ""} className="ui-input px-3 py-2 text-sm">
          <option value="">All channels</option>
          <option value="console">Customer chat</option>
          {channelDefinitions.map(channel => <option key={channel.kind} value={channel.kind}>
            {channel.label}
          </option>)}
        </select>
        <div className="flex gap-2">
          <button className="ui-primary-button px-3 py-2" aria-label="Apply filters" title="Apply filters"><Filter size={18} aria-hidden="true"/></button>
          <Link href={action} className="ui-button px-3 py-2" aria-label="Reset filters" title="Reset filters"><RotateCcw size={18} aria-hidden="true"/></Link>
        </div>
      </div>
      <details className="group text-sm">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-muted [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal size={16} aria-hidden="true"/>More filters<ChevronDown size={14} aria-hidden="true" className="transition-transform group-open:rotate-180"/>
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs text-muted">Status<select name="status" defaultValue={filters.status ?? ""} className="ui-input mt-1 block w-full px-3 py-2 text-sm">
            <option value="">All statuses</option><option value="needs_reply">Needs attention</option>
            <option value="pending">Pending</option>
            <option value="active">Open</option><option value="escalated">With your team</option><option value="closed">Resolved</option>
          </select></label>
          <label className="text-xs text-muted">Issue type<input name="reason" defaultValue={filters.reasonCode ?? ""}
            className="ui-input mt-1 block w-full px-3 py-2 text-sm" placeholder="Filter by issue"/></label>
          <label className="text-xs text-muted">From<input name="from" type="date" defaultValue={filters.from ?? ""}
            className="ui-input mt-1 block w-full px-3 py-2 text-sm" aria-label="From date"/></label>
          <label className="text-xs text-muted">To<input name="to" type="date" defaultValue={filters.to ?? ""}
            className="ui-input mt-1 block w-full px-3 py-2 text-sm" aria-label="To date"/></label>
        </div>
      </details>
    </form>
  );
}

export function ConversationList({
  conversations,
  hrefForConversation,
  showClient = false,
  emptyText = "No conversations match these filters.",
  ctaLabel = "Review",
}: {
  conversations: FilteredConversation[];
  hrefForConversation: (conversation: FilteredConversation) => string;
  showClient?: boolean;
  emptyText?: string;
  ctaLabel?: string;
}) {
  return (
    <div className="divide-y divide-line">
      {conversations.length === 0 ? (
        <p className="p-4 text-sm text-muted">{emptyText}</p>
      ) : (
        conversations.map((conversation) => {
          const needsReply = Boolean(conversation.active_escalation_id || conversation.owner_action_required);
          const resolved = conversation.is_resolved === true && !needsReply;
          return (
          <Link
            key={conversation.id}
            href={hrefForConversation(conversation)}
            data-resolved={resolved}
            data-needs-reply={needsReply}
            className={`group flex flex-col gap-4 p-4 hover:bg-surface-hover sm:flex-row sm:items-center sm:justify-between ${needsReply ? "bg-warning-bg/40" : resolved ? "bg-surface/40" : ""}`}
          >
            <div className={`min-w-0 ${resolved ? "opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className={`flex items-center gap-2 ${needsReply ? "font-semibold" : "font-medium"}`}>
                  {needsReply && <span aria-label="Needs team reply" className="h-2 w-2 shrink-0 rounded-full bg-amber-600"/>}
                  {conversation.customer_name ?? conversation.customer_handle}
                </p>
                {showClient ? <Badge>{conversation.client_name}</Badge> : null}
                <span className="text-xs text-muted">{conversation.channel_kind === "console" ? "Instagram" : channelDefinition(conversation.channel_kind).label}</span>
                {conversation.urgency === "short_term" && <Badge tone="amber">Priority</Badge>}
                {conversation.active_escalation_id ? <Badge tone="amber">Needs reply</Badge>
                  : conversation.owner_action_required ? <Badge tone="amber">Review requested</Badge>
                  : null}
                {showClient && conversation.assigned_to_name ? <Badge>Assigned: {conversation.assigned_to_name}</Badge> : null}
                {showClient && conversation.delivery_status && ["failed", "dead", "uncertain"].includes(conversation.delivery_status)
                  ? <Badge tone="red">Delivery {conversation.delivery_status}</Badge> : null}
              </div>
              {conversation.active_escalation_id && <p className="mt-1 text-xs font-medium text-amber-800">Team reply needed · {conversation.status === "active" ? "Pronto can answer other questions" : "AI paused"}</p>}
              <p className="mt-1 line-clamp-2 text-sm text-muted">
                {conversation.last_message ? conversation.last_sender_role === "customer" ? conversation.last_message : plainMessageText(conversation.last_message) : "No message yet."}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
            <time className="text-xs text-muted" dateTime={new Date(conversation.last_message_at).toISOString()}>{formatDateTime(conversation.last_message_at)}</time>
            {resolved ? <span className="inline-flex items-center gap-2 text-success" aria-label="Resolved">
              <CheckCircle2 size={22} aria-hidden="true"/><span className="sr-only">Resolved</span>
            </span> : <span className="inline-flex items-center gap-2 text-sm font-medium text-accent">
              <Image
                src={channelDefinition(conversation.channel_kind).iconPath}
                alt=""
                width={20}
                height={20}
                className="h-5 w-5"
              />
              {conversation.active_escalation_id ? "Reply" : ctaLabel}
              <ArrowRight size={16} />
            </span>}
            </span>
          </Link>
          );
        })
      )}
    </div>
  );
}

export function PaginationControls({
  action,
  searchParams,
  page,
  hasNext,
}: {
  action: string;
  searchParams: Record<string, string | string[] | undefined>;
  page: number;
  hasNext: boolean;
}) {
  if (page <= 1 && !hasNext) return null;

  return (
    <nav className="flex items-center justify-between gap-3 border-t border-line p-4 text-sm" aria-label="Pagination">
      <Link
        href={pageHref(action, searchParams, page - 1)}
        aria-disabled={page <= 1}
        className={`ui-button px-3 py-2 ${page <= 1 ? "pointer-events-none opacity-50" : ""}`}
      >
        Previous
      </Link>
      <span className="text-muted">Page {page}</span>
      <Link
        href={pageHref(action, searchParams, page + 1)}
        aria-disabled={!hasNext}
        className={`ui-button px-3 py-2 ${hasNext ? "" : "pointer-events-none opacity-50"}`}
      >
        Next
      </Link>
    </nav>
  );
}

export function filtersFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
  clientId?: string,
): ConversationFilterInput {
  return {
    clientId,
    query: firstParam(searchParams.q),
    channelKind: firstParam(searchParams.channel),
    status: firstParam(searchParams.status),
    reasonCode: firstParam(searchParams.reason),
    from: firstParam(searchParams.from),
    to: firstParam(searchParams.to),
  };
}

export function pageFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): number {
  const value = Number(firstParam(searchParams.page) ?? "1");
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pageHref(
  action: string,
  searchParams: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    const first = firstParam(value);
    if (first && key !== "page") params.set(key, first);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${action}?${query}` : action;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "Pending";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.round(seconds / 3600)}h`;
}
