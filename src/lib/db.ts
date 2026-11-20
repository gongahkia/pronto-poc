import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { databaseUrl } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { getTenantContext } from "@/lib/tenant-context";
import { attachDatabasePool } from "@vercel/functions";
import { protectedDemoDeployment } from "@/lib/deployment-profile";

type GlobalWithPool = typeof globalThis & {
  prontoPool?: Pool;
};

export type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};

const globalForPool = globalThis as GlobalWithPool;

export function getPool(): Pool {
  if (!globalForPool.prontoPool) {
    globalForPool.prontoPool = new Pool({
      ...databaseConnectionOptions(),
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    // An idle Neon connection can disappear on compute suspension/restart.
    // pg removes that client; handle the event without terminating the process.
    globalForPool.prontoPool.on('error',error=>logWarn('db.idle_client_error',{error}));
    if (process.env.VERCEL === "1") attachDatabasePool(globalForPool.prontoPool);
  }

  return globalForPool.prontoPool;
}

export function databaseConnectionOptions() {
  const vercel = process.env.VERCEL === "1";
  const requested = Number(process.env.PRONTO_DB_POOL_MAX);
  const max = Number.isInteger(requested) && requested >= 1 && requested <= 20 ? requested : vercel ? 2 : 10;
  let connectionString = databaseUrl();
  let ssl: { rejectUnauthorized: true; ca?: string } | undefined;
  if (protectedDemoDeployment()) {
    const url = new URL(connectionString);
    if (["disable","no-verify","allow","prefer"].includes(url.searchParams.get("sslmode") ?? ""))
      throw new Error("Protected demo database TLS verification cannot be disabled.");
    // pg URL ssl parameters override the SSL object; enforce verification here.
    for (const name of ["sslmode","sslcert","sslkey","sslrootcert"]) url.searchParams.delete(name);
    connectionString = url.toString();
    ssl = { rejectUnauthorized: true, ...(process.env.PRONTO_DATABASE_CA ? { ca: process.env.PRONTO_DATABASE_CA } : {}) };
  }
  return { connectionString, max, min: 0, idleTimeoutMillis: vercel ? 5000 : 30000, ...(ssl ? { ssl } : {}) };
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  assertTenantScopedQuery(text, values);
  return getPool().query<T>(text, values);
}

export async function transaction<T>(
  callback: (client: Queryable) => Promise<T>,
  options: {
    isolationLevel?: "read committed" | "repeatable read" | "serializable";
    retries?: number;
    leakWarningMs?: number;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTransaction(callback, options);
    } catch (error) {
      if (attempt >= retries || !isSerializationFailure(error)) {
        throw error;
      }
      logWarn("db.transaction_retry", { attempt: attempt + 1, error });
    }
  }
}

async function runTransaction<T>(
  callback: (client: Queryable) => Promise<T>,
  options: {
    isolationLevel?: "read committed" | "repeatable read" | "serializable";
    leakWarningMs?: number;
  },
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  const startedAt = Date.now();
  const leakWarningMs = options.leakWarningMs ?? 30_000;
  const timer = setTimeout(() => {
    logWarn("db.transaction_held_too_long", {
      heldMs: Date.now() - startedAt,
      isolationLevel: options.isolationLevel ?? "read committed",
    });
  }, leakWarningMs);
  timer.unref?.();

  try {
    await client.query(beginStatement(options.isolationLevel));
    const guardedClient: Queryable = {
      query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => {
        assertTenantScopedQuery(text, values ?? []);
        return client.query<T>(text, values);
      },
    };
    const result = await callback(guardedClient);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    clearTimeout(timer);
    client.release();
  }
}

function beginStatement(
  isolationLevel: "read committed" | "repeatable read" | "serializable" | undefined,
): string {
  if (!isolationLevel || isolationLevel === "read committed") {
    return "begin";
  }
  return `begin isolation level ${isolationLevel}`;
}

function isSerializationFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "40001",
  );
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function assertTenantScopedQuery(text: string, values: unknown[]): void {
  if (!tenantSqlGateEnabled()) return;
  const context = getTenantContext();
  if (context?.role !== "client") return;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  if (!mentionsClientScopedTable(normalized)) return;
  if (!context.clientId) {
    throw new Error("Client-scoped query must include client_id.");
  }
  if (isTenantInsert(normalized)) {
    if (hasBoundClientIdInsertValue(normalized, values, context.clientId)) {
      return;
    }
    throw new Error("Client-scoped query must include client_id.");
  }
  if (hasBoundClientIdPredicate(normalized, values, context.clientId)) {
    return;
  }
  throw new Error("Client-scoped query must include client_id.");
}

function tenantSqlGateEnabled(): boolean {
  if (process.env.PRONTO_DISABLE_TENANT_SQL_GATE === "1") return false;
  return process.env.PRONTO_ENFORCE_TENANT_SQL === "1" || process.env.NODE_ENV === "production";
}

function mentionsClientScopedTable(sql: string): boolean {
  return /\b(from|join|update|into|delete from)\s+(selfserve_settings|selfserve_sources|selfserve_rules|selfserve_conflicts|selfserve_voice_sessions|selfserve_jobs|selfserve_alert_deliveries|selfserve_owner_replies|messages|conversations|escalations|channels|knowledge_sources|knowledge_chunks|knowledge_suggestions|knowledge_suggestion_revisions|staff_command_requests|agent_configs|agent_usage_events|agent_traces|audit_logs|metric_events|brand_voice_documents|brand_voice_examples|csat_responses|outbound_messages|integration_credentials|knowledge_refresh_requests|reservation_availability_cache|reservation_availability_observations|client_insight_snapshots|demo_feedback_threads|demo_feedback_comments|demo_processing_status|provider_cooldowns)\b/.test(sql);
}

function isTenantInsert(sql: string): boolean {
  return /\binsert\s+into\s+(selfserve_settings|selfserve_sources|selfserve_rules|selfserve_conflicts|selfserve_voice_sessions|selfserve_jobs|selfserve_alert_deliveries|selfserve_owner_replies|messages|conversations|escalations|channels|knowledge_sources|knowledge_chunks|knowledge_suggestions|knowledge_suggestion_revisions|staff_command_requests|agent_configs|agent_usage_events|agent_traces|audit_logs|metric_events|brand_voice_documents|brand_voice_examples|csat_responses|outbound_messages|integration_credentials|knowledge_refresh_requests|reservation_availability_cache|reservation_availability_observations|client_insight_snapshots|demo_feedback_threads|demo_feedback_comments|demo_processing_status|provider_cooldowns)\b/.test(sql);
}

function hasBoundClientIdInsertValue(
  sql: string,
  values: unknown[],
  clientId: string,
): boolean {
  const match = sql.match(
    /\binsert\s+into\s+(selfserve_settings|selfserve_sources|selfserve_rules|selfserve_conflicts|selfserve_voice_sessions|selfserve_jobs|selfserve_alert_deliveries|selfserve_owner_replies|messages|conversations|escalations|channels|knowledge_sources|knowledge_chunks|knowledge_suggestions|knowledge_suggestion_revisions|staff_command_requests|agent_configs|agent_usage_events|agent_traces|audit_logs|metric_events|brand_voice_documents|brand_voice_examples|csat_responses|outbound_messages|integration_credentials|knowledge_refresh_requests|reservation_availability_cache|reservation_availability_observations|client_insight_snapshots|demo_feedback_threads|demo_feedback_comments|demo_processing_status|provider_cooldowns)\s*\(([^)]*)\)\s*values\s*/,
  );
  if (!match) {
    return false;
  }
  const valueList = readParenthesizedList(sql, (match.index ?? 0) + match[0].length);
  if (!valueList) {
    return false;
  }

  const columns = splitTopLevelComma(match[2]).map((column) =>
    column.trim().replace(/^"|"$/g, ""),
  );
  const clientIdColumnIndex = columns.indexOf("client_id");
  if (clientIdColumnIndex < 0) {
    return false;
  }

  const insertValues = splitTopLevelComma(valueList);
  const clientIdValue = insertValues[clientIdColumnIndex]?.trim();
  const parameter = clientIdValue?.match(/^\$(\d+)(?:::?[a-z_][a-z0-9_]*)?$/);
  if (!parameter) {
    return false;
  }

  return values[Number(parameter[1]) - 1] === clientId;
}

function readParenthesizedList(value: string, startIndex: number): string | null {
  if (value[startIndex] !== "(") {
    return null;
  }
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let content = "";

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    const previous = value[index - 1];

    if (character === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
    } else if (character === "\"" && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (character === "(") {
        if (depth > 0) {
          content += character;
        }
        depth += 1;
        continue;
      }
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          return content;
        }
      }
    }

    if (depth > 0) {
      content += character;
    }
  }

  return null;
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const previous = value[index - 1];

    if (character === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
    } else if (character === "\"" && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth = Math.max(0, depth - 1);
      } else if (character === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }

    current += character;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function hasBoundClientIdPredicate(
  sql: string,
  values: unknown[],
  clientId: string,
): boolean {
  const patterns = [
    /\bclient_id\b\s*=\s*\$(\d+)(?:::?[a-z_][a-z0-9_]*)?/g,
    /\$(\d+)(?:::?[a-z_][a-z0-9_]*)?\s*=\s*\bclient_id\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      const parameterIndex = Number(match[1]) - 1;
      if (values[parameterIndex] === clientId) {
        return true;
      }
    }
  }

  return false;
}
