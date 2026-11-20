import { query } from "@/lib/db";
import { channelKinds } from "@/lib/channels/catalog";
import type { Channel, ConversationStatus, EscalationStatus } from "@/lib/types";

export type ConversationFilterInput = {
  clientId?: string;
  businessSearch?: string;
  externalOnly?: boolean;
  query?: string;
  channelKind?: string;
  status?: string;
  reasonCode?: string;
  escalationStatus?: string;
  assignedSearch?: string;
  deliveryFailure?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sort?: "recent" | "attention";
};

export type FilteredConversation = {
  response_provider?: string | null;
  response_model?: string | null;
  generation_mode?: string | null;
  selected_provider?: string | null;
  selected_model?: string | null;
  ai_should_respond?: boolean | null;
  owner_action_required?: boolean;
  urgency?: "short_term" | "long_term" | null;
  id: string;
  client_id: string;
  client_name: string;
  channel_kind: Channel["kind"];
  customer_name: string | null;
  customer_handle: string | null;
  status: ConversationStatus;
  last_message_at: Date;
  created_at: Date;
  last_message: string | null;
  last_sender_role: string | null;
  active_escalation_id: string | null;
  active_escalation_status: EscalationStatus | null;
  active_escalation_reason_code: string | null;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  delivery_status: string | null;
  is_resolved?: boolean;
};

export type ClientDashboardAnalytics = {
  conversationCount: number;
  escalatedConversationCount: number;
  escalationRate: number;
  actionableEscalations: number;
  avgFirstResponseSeconds: number | null;
  csatAverage: number | null;
  csatResponses: number;
};

export type OperatorClientHealth = {
  clientId: string;
  name: string;
  vertical: string;
  planTier: string;
  status: string;
  health: "critical" | "warning" | "healthy";
  activeChannels: number;
  degradedChannels: number;
  openTriage: number;
  knowledgeSources: number;
  latestActivityAt: Date | null;
};

export type OperatorCommandCenter = {
  needsActionNow: number;
  channelIssues: number;
  degradedClients: number;
  setupNeeds: number;
  clientHealth: OperatorClientHealth[];
};

type SqlFilter = {
  where: string[];
  values: unknown[];
};

const channelKindSet = new Set(channelKinds);
const conversationStatuses = new Set(["active", "escalated", "closed"]);

const actionableEscalationCondition = `
  (
    e.status <> 'resolved'
    or owner_reply.status in ('pending', 'sending', 'failed')
  )
`;

// A delivered assistant answer completes the current enquiry without closing
// the chat to future messages. New/pending messages make it open again.
const resolvedConversationCondition = `(ae.id is null and not c.owner_action_required and (
  (c.status='closed' and (delivery.status is null or delivery.status='sent'))
  or (c.status='active' and c.ai_should_respond=true and lm.sender_role='agent' and delivery.status='sent'
    and not exists(select 1 from inbound_jobs pending_job where pending_job.client_id=c.client_id
      and pending_job.conversation_id=c.id and pending_job.status in ('pending','processing','failed','dead')))
))`;

export async function getFilteredConversations(
  input: ConversationFilterInput = {},
): Promise<FilteredConversation[]> {
  const filters = buildConversationFilters(input);
  const limit = normalizeLimit(input.limit, 50);
  const offset = normalizeOffset(input.offset);
  const result = await query<FilteredConversation>(
    `
      select
        c.id,
        c.client_id,
        cl.name as client_name,
        ch.kind as channel_kind,
        c.customer_name,
        c.customer_handle,
        c.status,
        c.ai_should_respond, c.owner_action_required, c.urgency,
        c.last_message_at,
        c.created_at,
        lm.body as last_message,
        lm.sender_role as last_sender_role,
        ae.id as active_escalation_id,
        ae.status as active_escalation_status,
        ae.reason_code as active_escalation_reason_code
        ,ae.assigned_to_user_id,
        assignee.name as assigned_to_name,
        delivery.status as delivery_status
        ,${resolvedConversationCondition} as is_resolved
        ,model_message.provider as response_provider,model_message.model as response_model,
        model_message.mode as generation_mode
        ,ds.ai_configuration->>'provider' as selected_provider,ds.ai_configuration->>'model' as selected_model
      from conversations c
      join clients cl on cl.id = c.client_id
      join channels ch on ch.id = c.channel_id
      left join customer_demo_sessions ds on ds.conversation_id=c.id and ds.client_id=c.client_id
      left join lateral (
        select metadata->>'responseProvider' as provider,metadata->>'responseModel' as model,
          metadata->>'generationMode' as mode from messages
        where conversation_id=c.id and client_id=c.client_id and sender_role='agent'
          and metadata->>'generationMode' in ('real','mock') order by created_at desc,id desc limit 1
      ) model_message on true
      left join lateral (
        select body, sender_role
        from messages
        where conversation_id = c.id
        order by created_at desc
        limit 1
      ) lm on true
      left join lateral (
        select e.id, e.status, e.reason_code, e.assigned_to_user_id
        from escalations e
        left join lateral (
          select status
          from outbound_messages
          where escalation_id = e.id
            and metadata->>'purpose' = 'escalation_resolution_reply'
          order by created_at desc
          limit 1
        ) owner_reply on true
        where e.conversation_id = c.id
          and ${actionableEscalationCondition}
        order by e.created_at desc
        limit 1
      ) ae on true
      left join users assignee on assignee.id = ae.assigned_to_user_id
      left join lateral (
        select status from outbound_messages where conversation_id = c.id and client_id = c.client_id
        order by created_at desc limit 1
      ) delivery on true
      ${filters.where.length ? `where ${filters.where.join(" and ")}` : ""}
      order by ${input.sort === "attention" ? `case
        when ae.id is not null then 0
        when c.status = 'escalated' then 1
        when c.owner_action_required and c.status = 'active' then 2
        when c.status = 'active' then 3
        else 4
      end,` : ""} c.last_message_at desc, c.id desc
      limit $${filters.values.length + 1}
      offset $${filters.values.length + 2}
    `,
    [...filters.values, limit, offset],
  );
  return result.rows;
}

export async function getClientDashboardAnalytics(
  clientId: string,
): Promise<ClientDashboardAnalytics> {
  const [conversationStats, actionable, firstResponse, csat] =
    await Promise.all([
      query<{
        conversations: string;
        escalated: string;
      }>(
        `
          select
            count(*) as conversations,
            count(*) filter (where status = 'escalated') as escalated
          from conversations
          where client_id = $1 and deleted_at is null
        `,
        [clientId],
      ),
      query<{ count: string }>(
        `
          select count(*)
          from escalations e
          join conversations c on c.id = e.conversation_id and c.client_id = e.client_id and c.deleted_at is null
          left join lateral (
            select status
            from outbound_messages
            where escalation_id = e.id
              and metadata->>'purpose' = 'escalation_resolution_reply'
            order by created_at desc
            limit 1
          ) owner_reply on true
          where e.client_id = $1
            and ${actionableEscalationCondition}
        `,
        [clientId],
      ),
      query<{ seconds: string | null }>(
        `
          select avg(extract(epoch from (first_response.created_at - customer.created_at)))::text as seconds
          from messages customer
          join conversations c on c.id = customer.conversation_id and c.client_id = customer.client_id and c.deleted_at is null
          join lateral (
            select created_at
            from messages
            where conversation_id = customer.conversation_id
              and sender_role in ('agent', 'operator')
              and created_at > customer.created_at
            order by created_at asc
            limit 1
          ) first_response on true
          where customer.client_id = $1 and customer.sender_role = 'customer'
        `,
        [clientId],
      ),
      query<{ average: string | null; count: string }>(
        `
          select avg(r.score)::text as average, count(*) as count
          from csat_responses r
          join conversations c on c.id = r.conversation_id and c.client_id = r.client_id and c.deleted_at is null
          where r.client_id = $1
        `,
        [clientId],
      ),
    ]);

  const row = conversationStats.rows[0];
  const conversationCount = Number(row.conversations);
  const escalatedConversationCount = Number(row.escalated);

  return {
    conversationCount,
    escalatedConversationCount,
    escalationRate: conversationCount
      ? escalatedConversationCount / conversationCount
      : 0,
    actionableEscalations: Number(actionable.rows[0].count),
    avgFirstResponseSeconds: parseNullableNumber(firstResponse.rows[0]?.seconds),
    csatAverage: parseNullableNumber(csat.rows[0]?.average),
    csatResponses: Number(csat.rows[0]?.count ?? 0),
  };
}

export async function getOperatorCommandCenter(): Promise<OperatorCommandCenter> {
  const clientHealth = await query<{
    client_id: string;
    name: string;
    vertical: string;
    plan_tier: string;
    status: string;
    active_channels: string;
    degraded_channels: string;
    open_triage: string;
    knowledge_sources: string;
    latest_activity_at: Date | null;
  }>(
    `
      with actionable as (
        select e.id, e.client_id
        from escalations e
        left join lateral (
          select status
          from outbound_messages
          where escalation_id = e.id
            and metadata->>'purpose' = 'escalation_resolution_reply'
          order by created_at desc
          limit 1
        ) owner_reply on true
        where ${actionableEscalationCondition}
      )
      select
        cl.id as client_id,
        cl.name,
        cl.vertical,
        cl.plan_tier,
        cl.status,
        count(distinct ch.id) filter (where ch.status = 'active')::text as active_channels,
        count(distinct ch.id) filter (where ch.last_health_status in ('degraded', 'unconfigured'))::text as degraded_channels,
        count(distinct a.id)::text as open_triage,
        count(distinct ks.id)::text as knowledge_sources,
        max(c.last_message_at) as latest_activity_at
      from clients cl
      left join channels ch on ch.client_id = cl.id
      left join actionable a on a.client_id = cl.id
      left join knowledge_sources ks on ks.client_id = cl.id
      left join conversations c on c.client_id = cl.id
      group by cl.id, cl.name, cl.vertical, cl.plan_tier, cl.status
      order by
        count(distinct ch.id) filter (where ch.last_health_status in ('degraded', 'unconfigured')) desc,
        count(distinct a.id) desc,
        max(c.last_message_at) desc nulls last,
        cl.created_at desc
    `,
  );

  const health = clientHealth.rows.map((row): OperatorClientHealth => {
    const degradedChannels = Number(row.degraded_channels);
    const activeChannels = Number(row.active_channels);
    const openTriage = Number(row.open_triage);
    const knowledgeSources = Number(row.knowledge_sources);
    const healthStatus =
      degradedChannels > 0
        ? "critical"
        : row.status !== "live" ||
            activeChannels === 0 ||
            knowledgeSources === 0 ||
            openTriage > 0
          ? "warning"
          : "healthy";

    return {
      clientId: row.client_id,
      name: row.name,
      vertical: row.vertical,
      planTier: row.plan_tier,
      status: row.status,
      health: healthStatus,
      activeChannels,
      degradedChannels,
      openTriage,
      knowledgeSources,
      latestActivityAt: row.latest_activity_at,
    };
  });

  const openTriageCount = health.reduce((sum, row) => sum + row.openTriage, 0);
  const channelIssueCount = health.reduce((sum, row) => sum + row.degradedChannels, 0);
  const degradedClientCount = health.filter((row) => row.health === "critical").length;
  const setupNeedCount = health.filter(
    (row) => row.status !== "live" || row.activeChannels === 0 || row.knowledgeSources === 0,
  ).length;

  return {
    needsActionNow: openTriageCount + channelIssueCount,
    channelIssues: channelIssueCount,
    degradedClients: degradedClientCount,
    setupNeeds: setupNeedCount,
    clientHealth: health,
  };
}

function buildConversationFilters(input: ConversationFilterInput): SqlFilter {
  const where: string[] = ["c.deleted_at is null"];
  const values: unknown[] = [];

  if (input.clientId) {
    where.push(`c.client_id = $${pushParam(values, input.clientId)}`);
  }
  if (input.externalOnly) where.push("ch.kind <> 'console'");
  if (input.businessSearch?.trim()) {
    where.push(`cl.name ilike $${pushParam(values, `%${input.businessSearch.trim()}%`)}`);
  }
  if (input.query?.trim()) {
    const value = `%${input.query.trim()}%`;
    const param = pushParam(values, value);
    where.push(`(
      cl.name ilike $${param}
      or
      c.customer_name ilike $${param}
      or c.customer_handle ilike $${param}
      or lm.body ilike $${param}
    )`);
  }
  if (input.channelKind && channelKindSet.has(input.channelKind as Channel["kind"])) {
    where.push(`ch.kind = $${pushParam(values, input.channelKind)}::channel_kind`);
  }
  if (input.status === "needs_reply") {
    where.push("(ae.id is not null or c.owner_action_required)");
  } else if (input.status === "pending") {
    where.push("(c.owner_action_required or exists(select 1 from inbound_jobs j where j.client_id=c.client_id and j.conversation_id=c.id and j.status in ('pending','processing','failed','dead')))");
  } else if (input.status === "ai_handled") {
    where.push("(c.status='active' and c.ai_should_respond=true and not c.owner_action_required and ae.id is null)");
  } else if (input.status === "closed") {
    where.push(resolvedConversationCondition);
  } else if (input.status && conversationStatuses.has(input.status)) {
    where.push(`c.status = $${pushParam(values, input.status)}::conversation_status`);
  }
  if (input.reasonCode?.trim()) {
    where.push(`ae.reason_code = $${pushParam(values, input.reasonCode.trim())}`);
  }
  if (input.escalationStatus && ["open", "claimed"].includes(input.escalationStatus)) {
    where.push(`ae.status = $${pushParam(values, input.escalationStatus)}::escalation_status`);
  }
  if (input.assignedSearch?.trim()) {
    const assigned = input.assignedSearch.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assigned))
      where.push(`ae.assigned_to_user_id = $${pushParam(values, assigned)}::uuid`);
    else where.push(`assignee.name ilike $${pushParam(values, `%${assigned}%`)}`);
  }
  if (input.deliveryFailure) where.push("delivery.status in ('failed', 'dead', 'uncertain')");
  if (isDateInput(input.from)) {
    where.push(`c.last_message_at >= $${pushParam(values, input.from)}::timestamptz`);
  }
  if (isDateInput(input.to)) {
    where.push(
      `c.last_message_at < ($${pushParam(values, input.to)}::date + interval '1 day')`,
    );
  }

  return { where, values };
}

function pushParam(values: unknown[], value: unknown): number {
  values.push(value);
  return values.length;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return fallback;
  }
  return Math.min(value, 100);
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0) {
    return 0;
  }
  return value;
}

function parseNullableNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateInput(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}
