import { query, type Queryable } from "@/lib/db";
import type { Channel } from "@/lib/types";
import { protectedDemoConfiguration, protectedDemoDeployment } from "@/lib/deployment-profile";
import {demoBusinessScope,LEGACY_DEMO_SCOPE} from '@/lib/demo-business';

// Legacy fixture exports remain stable for saved evaluation evidence. Runtime
// code resolves the selected business through demoBusinessScope instead.
export const DEMO_CLIENT_ID = LEGACY_DEMO_SCOPE.clientId;
export const DEMO_CHANNEL_ID = LEGACY_DEMO_SCOPE.channelId;
export const DEMO_SLUG = LEGACY_DEMO_SCOPE.slug;

export class DemoError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export async function assertCustomerDemoEnabled(db: Queryable = { query }): Promise<void> {
  demoBusinessScope();
  if (protectedDemoDeployment()) {
    let settings: ReturnType<typeof protectedDemoConfiguration>;
    try { settings = protectedDemoConfiguration(); }
    catch { throw new DemoError("The protected customer demo is not safely configured.", 503); }
    const identity = await db.query<{ safe: boolean }>(`select
      shobj_description(oid,'pg_database')=$1 as safe from pg_database where datname=current_database()`, [settings.marker]);
    if (!identity.rows[0]?.safe) throw new DemoError("Protected demo database identity verification failed.", 503);
    return;
  }
  if (process.env.PRONTO_CUSTOMER_DEMO_ENABLED !== "1" || process.env.NODE_ENV === "production")
    throw new DemoError("The authenticated local customer simulator is disabled.", 404);
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.DATABASE_URL !== process.env.PRONTO_TEST_DATABASE_URL ||
        !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
        url.pathname !== "/pronto_test" || !url.port) throw new Error();
  } catch { throw new DemoError("Customer simulation requires the verified local test database.", 503); }
  const result = await db.query<{ safe: boolean }>(`select current_database()='pronto_test'
    and inet_server_addr() in ('127.0.0.1'::inet, '::1'::inet)
    and shobj_description(oid, 'pg_database')='pronto:isolated-test-database:v1' as safe
    from pg_database where datname=current_database()`);
  if (!result.rows[0]?.safe) throw new DemoError("Local database identity verification failed.", 503);
}

export function isCustomerDemoChannel(channel: Pick<Channel, "id" | "client_id" | "kind" | "settings">): boolean {
  const scope=demoBusinessScope();
  return channel.id === scope.channelId && channel.client_id === scope.clientId &&
    channel.kind === "console" && channel.settings.transport === "customer_simulator";
}

// Knowledge authoring shares the same verified synthetic boundary as chat.
// Missing provider keys never select this mode for an ordinary business.
export async function usesDemoTextKnowledge(clientId: string): Promise<boolean> {
  const scope=demoBusinessScope();
  if (clientId !== scope.clientId ||
      (!protectedDemoDeployment() && process.env.PRONTO_CUSTOMER_DEMO_ENABLED !== "1")) return false;
  await assertCustomerDemoEnabled();
  const identity = await query<{ safe: boolean }>(`select exists(select 1 from clients
    where id = $1 and slug = $2 and business_profile->>'demoSeed' = $3) as safe`,
  [scope.clientId, scope.slug, scope.seed]);
  if (!identity.rows[0]?.safe) throw new DemoError("Synthetic knowledge tenant identity verification failed.", 503);
  return true;
}
