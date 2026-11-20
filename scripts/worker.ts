import { flushRetryableOutboundMessages, markStaleOutboundUncertain } from "../src/lib/channels/outbox";
import { expireExhaustedInboundLeases } from "../src/lib/channels/inbox";
import { processInboundJob } from "../src/lib/channels/inbox-worker";
import { getPool } from "../src/lib/db";
import { redactErrorMessage } from "../src/lib/logger";
import { flushStaffNotifications, markExpiredStaffNotificationsUncertain } from "../src/lib/staff-notifications";
import { refreshDueChopeAvailability } from "../src/lib/reservations/availability-cache";

const intervalMs = positiveNumber("PRONTO_WORKER_OUTBOX_INTERVAL_MS", 15_000);
const batchLimit = positiveNumber("PRONTO_WORKER_OUTBOX_LIMIT", 25);
const inboundLimit = positiveNumber("PRONTO_WORKER_INBOUND_LIMIT", 25);
let shuttingDown = false;

async function main() {
  console.log(
    JSON.stringify({
      event: "worker.started",
      outboxIntervalMs: intervalMs,
      outboxLimit: batchLimit,
      inboundLimit,
    }),
  );

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (!shuttingDown) {
    const startedAt = Date.now();
    try {
      if(process.env.PRONTO_SELF_SERVE_ENABLED==='1'){const {processNextSelfServeWorkspace}=await import('../src/lib/self-serve/jobs');await processNextSelfServeWorkspace();}
      await expireExhaustedInboundLeases();
      for (let index = 0; index < inboundLimit && !shuttingDown; index += 1) {
        try {
          const job = await processInboundJob({ requestId: `worker-${startedAt}` });
          if (!job) break;
        } catch (error) {
          console.error(JSON.stringify({ event: "worker.inbound_failed",
            error: redactErrorMessage(error) }));
        }
      }
      await markStaleOutboundUncertain();
      await markExpiredStaffNotificationsUncertain();
      const result = await flushRetryableOutboundMessages({
        requestId: `worker-${startedAt}`,
        limit: batchLimit,
      });
      if (result.attempted > 0) {
        console.log(JSON.stringify({ event: "worker.outbox_flushed", ...result }));
      }
      await flushStaffNotifications(batchLimit);
      await refreshDueChopeAvailability();
      await getPool().query(
        `insert into worker_heartbeats (name, updated_at) values ('inbound-outbound', now())
         on conflict (name) do update set updated_at = now()`,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "worker.outbox_failed",
          error: redactErrorMessage(error),
        }),
      );
    }
    await sleep(Math.max(1_000, intervalMs - (Date.now() - startedAt)));
  }

  await getPool().end();
  console.log(JSON.stringify({ event: "worker.stopped" }));
}

function shutdown() {
  shuttingDown = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

main().catch(async (error) => {
  console.error(redactErrorMessage(error));
  await getPool().end();
  process.exit(1);
});
