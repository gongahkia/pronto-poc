import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { logInfo } from "@/lib/logger";

type DeliveryContext = { outboundMessageId: string; clientId: string; channelId: string;
  conversationId: string | null; escalationId?: string | null; customerMessageId?: string;
  attemptCount: number; requestId?: string };
const storage = new AsyncLocalStorage<DeliveryContext & { deliveryAttemptId: string }>();

export function deliveryDebugEnabled(): boolean {
  return process.env.PRONTO_DEBUG_DELIVERY === "1" && process.env.NODE_ENV !== "production";
}

export function withDeliveryDebugContext<T>(context: DeliveryContext, run: () => Promise<T>): Promise<T> {
  if (!deliveryDebugEnabled()) return run();
  return storage.run({ ...context, deliveryAttemptId: randomUUID() }, run);
}

export function logDeliveryDebug(event: string, metadata: Record<string, unknown> = {}): void {
  if (!deliveryDebugEnabled()) return;
  try { logInfo(event, { ...metadata, ...storage.getStore(), debugDelivery: true, processId: process.pid }); }
  catch { /* diagnostic sink failures must not change a delivery outcome */ }
}

export function providerIdentifierHash(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4096) return undefined;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
