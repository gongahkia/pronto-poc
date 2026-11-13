import { recordAuditLog } from "@/lib/audit";
import { query, transaction } from "@/lib/db";

export type BulkEscalationAction = "claim" | "assign" | "resolve";

export type BulkActionResult = {
  attempted: number;
  applied: number;
  skipped: string[];
};

export async function bulkClaimEscalations(input: {
  escalationIds: string[];
  clientId: string;
  actorUserId: string;
}): Promise<BulkActionResult> {
  const ids = dedupe(input.escalationIds);
  if (!ids.length) return { attempted: 0, applied: 0, skipped: [] };

  return transaction(async (client) => {
    await client.query(`select c.id from conversations c where c.client_id=$2 and exists
      (select 1 from escalations e where e.conversation_id=c.id and e.client_id=c.client_id and e.id=any($1::uuid[]))
      order by c.id for update`, [ids, input.clientId]);
    const updated = await client.query<{ id: string }>(
      `
        update escalations
        set status = 'claimed', assigned_to_user_id = $3
        where id = any($1::uuid[])
          and client_id = $2
          and status = 'open'
        returning id
      `,
      [ids, input.clientId, input.actorUserId],
    );
    for (const row of updated.rows) {
      await recordAuditLog(
        {
          clientId: input.clientId,
          actorUserId: input.actorUserId,
          action: "escalation.bulk_claimed",
          targetType: "escalation",
          targetId: row.id,
          metadata: { batchSize: ids.length },
        },
        client,
      );
    }
    await client.query(`update conversations c set status='escalated', ai_should_respond=false, owner_action_required=true
      where c.client_id=$2 and exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id
      and e.id=any($1::uuid[]) and e.status='claimed')`, [ids, input.clientId]);
    const appliedSet = new Set(updated.rows.map((row) => row.id));
    return {
      attempted: ids.length,
      applied: updated.rows.length,
      skipped: ids.filter((id) => !appliedSet.has(id)),
    };
  }, { isolationLevel: "serializable", retries: 2 });
}

export async function bulkAssignEscalations(input: {
  escalationIds: string[];
  clientId: string;
  assigneeUserId: string;
  actorUserId: string;
}): Promise<BulkActionResult> {
  const ids = dedupe(input.escalationIds);
  if (!ids.length) return { attempted: 0, applied: 0, skipped: [] };

  return transaction(async (client) => {
    await client.query(`select c.id from conversations c where c.client_id=$2 and exists
      (select 1 from escalations e where e.conversation_id=c.id and e.client_id=c.client_id and e.id=any($1::uuid[]))
      order by c.id for update`, [ids, input.clientId]);
    const assigneeCheck = await client.query<{ id: string }>(
      "select id from users where id = $1 and client_id = $2",
      [input.assigneeUserId, input.clientId],
    );
    if (!assigneeCheck.rowCount) {
      return {
        attempted: ids.length,
        applied: 0,
        skipped: ids,
      };
    }

    const updated = await client.query<{ id: string }>(
      `
        update escalations
        set assigned_to_user_id = $3,
            status = case when status = 'open' then 'claimed' else status end
        where id = any($1::uuid[])
          and client_id = $2
          and status <> 'resolved'
        returning id
      `,
      [ids, input.clientId, input.assigneeUserId],
    );
    for (const row of updated.rows) {
      await recordAuditLog(
        {
          clientId: input.clientId,
          actorUserId: input.actorUserId,
          action: "escalation.bulk_assigned",
          targetType: "escalation",
          targetId: row.id,
          metadata: {
            assigneeUserId: input.assigneeUserId,
            batchSize: ids.length,
          },
        },
        client,
      );
    }
    await client.query(`update conversations c set status='escalated', ai_should_respond=false, owner_action_required=true
      where c.client_id=$2 and exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id
      and e.id=any($1::uuid[]) and e.status='claimed')`, [ids, input.clientId]);
    const appliedSet = new Set(updated.rows.map((row) => row.id));
    return {
      attempted: ids.length,
      applied: updated.rows.length,
      skipped: ids.filter((id) => !appliedSet.has(id)),
    };
  }, { isolationLevel: "serializable", retries: 2 });
}

export async function bulkResolveEscalations(input: {
  escalationIds: string[];
  clientId: string;
  actorUserId: string;
  resolutionNote?: string;
}): Promise<BulkActionResult> {
  const ids = dedupe(input.escalationIds);
  if (!ids.length) return { attempted: 0, applied: 0, skipped: [] };

  return transaction(async (client) => {
    const updated = await client.query<{ id: string; conversation_id: string }>(
      `
        update escalations
        set status = 'resolved',
            resolved_at = coalesce(resolved_at, now())
        where id = any($1::uuid[])
          and client_id = $2
          and status <> 'resolved'
        returning id, conversation_id
      `,
      [ids, input.clientId],
    );
    if (updated.rowCount) {
      await client.query(
        "update conversations c set status=case when exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status in ('open','claimed')) then 'escalated'::conversation_status else 'closed'::conversation_status end, ai_should_respond=false, owner_action_required=exists(select 1 from escalations e where e.client_id=c.client_id and e.conversation_id=c.id and e.status in ('open','claimed')), last_message_at=now() where c.id=any($1::uuid[]) and c.client_id=$2",
        [updated.rows.map((row) => row.conversation_id), input.clientId],
      );
    }
    for (const row of updated.rows) {
      await recordAuditLog(
        {
          clientId: input.clientId,
          actorUserId: input.actorUserId,
          action: "escalation.bulk_resolved",
          targetType: "escalation",
          targetId: row.id,
          metadata: {
            batchSize: ids.length,
            note: input.resolutionNote ?? null,
          },
        },
        client,
      );
    }
    const appliedSet = new Set(updated.rows.map((row) => row.id));
    return {
      attempted: ids.length,
      applied: updated.rows.length,
      skipped: ids.filter((id) => !appliedSet.has(id)),
    };
  }, { isolationLevel: "serializable", retries: 2 });
}

export async function listClientStaff(clientId: string): Promise<
  { id: string; name: string; email: string }[]
> {
  const result = await query<{ id: string; name: string; email: string }>(
    `
      select id, name, email
      from users
      where client_id = $1 and role = 'client'
      order by name asc
    `,
    [clientId],
  );
  return result.rows;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
