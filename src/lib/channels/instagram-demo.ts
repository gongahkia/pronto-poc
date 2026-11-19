import {demoBusinessScope} from "@/lib/demo-business";
import { z } from "zod";
import { query } from "@/lib/db";
import { assertCustomerDemoEnabled, DemoError } from "@/lib/customer-demo-boundary";
import { protectedDemoConfiguration } from "@/lib/deployment-profile";
import type { Channel } from "@/lib/types";
import type { AiExecutionProfile } from "@/lib/llm/execution-mode";

const scopeSchema = z.object({ channelId: z.uuid(), accountId: z.string().regex(/^\d+$/),
  senderIds: z.array(z.string().regex(/^\d+$/)).min(1).max(5) });
export function demoInstagramConfiguration() {
  if (process.env.PRONTO_DEMO_INSTAGRAM_ENABLED !== "1") return null;
  protectedDemoConfiguration();
  const value = scopeSchema.safeParse({ channelId: process.env.PRONTO_DEMO_INSTAGRAM_CHANNEL_ID,
    accountId: process.env.PRONTO_DEMO_INSTAGRAM_ACCOUNT_ID,
    senderIds: process.env.PRONTO_DEMO_INSTAGRAM_SENDER_IDS?.split(",").map(id => id.trim()) });
  if (!value.success || value.data.senderIds.includes(value.data.accountId))
    throw new DemoError("The demo Instagram scope is invalid.", 503);
  return value.data;
}
export function isDemoInstagramChannel(channel: Pick<Channel, "id" | "client_id" | "kind" | "settings" | "external_id">): boolean {
  const scope = demoInstagramConfiguration();
  return Boolean(scope && channel.id === scope.channelId && channel.client_id === demoBusinessScope().clientId &&
    channel.kind === "instagram" && channel.external_id === scope.accountId && channel.settings.authMode === "unified_login");
}
export async function assertDemoInstagramScope(channel: Channel, senderId?: string): Promise<void> {
  const scope = demoInstagramConfiguration();
  if (!scope || !isDemoInstagramChannel(channel) || channel.status !== "active" ||
      !channel.encrypted_credentials || channel.credentials.igUserId !== scope.accountId ||
      (senderId !== undefined && !scope.senderIds.includes(senderId)))
    throw new DemoError("This Instagram channel or tester is outside the approved demo scope.", 403);
  await assertCustomerDemoEnabled();
}
export async function demoInstagramAiProfile(channel: Channel, senderId: string): Promise<AiExecutionProfile> {
  await assertDemoInstagramScope(channel, senderId);
  // reuse the live demo's selected Groq model, approved knowledge and limits.
  const { requireRealDemoConfiguration, profileForDemoChoice } = await import("@/lib/customer-demo-ai");
  const config = await requireRealDemoConfiguration(true, profileForDemoChoice("groq-oss"));
  return { mode: "real", provider: config.provider, model: config.model,
    embeddingProvider: config.embeddingProvider, embeddingModel: config.embeddingModel,
    retrievalMode: "local_text", instagramDemoClientId: demoBusinessScope().clientId };
}
export async function assertDemoInstagramReady(): Promise<void> {
  const scope = demoInstagramConfiguration();
  if (!scope) return;
  const { rows: [stored] } = await query<Channel>("select * from channels where client_id=$1 and id=$2", [demoBusinessScope().clientId, scope.channelId]);
  if (!stored) throw new DemoError("The demo Instagram channel is unavailable.", 503);
  const { decryptChannelCredentials } = await import("./credentials");
  await demoInstagramAiProfile(decryptChannelCredentials(stored), scope.senderIds[0]);
}
