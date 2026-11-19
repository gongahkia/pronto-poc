import { z } from "zod";
import { query } from "@/lib/db";
import { LlmConfigurationError } from "@/lib/llm/errors";
import type { AiExecutionProfile } from "@/lib/llm/execution-mode";
import type { Channel } from "@/lib/types";
import { envApiKeyForProvider } from "@/lib/llm/credentials";
import { hasApprovedTextKnowledge } from "@/lib/knowledge/retrieve";
import { decryptChannelCredentials } from "./credentials";

export const instagramTestModel = "openai/gpt-oss-20b";
const settings = z.object({
  clientId: z.uuid(), channelId: z.uuid(), accountId: z.string().regex(/^\d+$/),
  marker: z.string().regex(/^pronto:instagram-hosted:v1:[0-9a-f-]{36}$/),
  senderIds: z.array(z.string().regex(/^\d+$/)).min(1).max(5),
});

export function instagramTestAiConfiguration() {
  if (process.env.PRONTO_HOSTED_INSTAGRAM_AI !== "1") return null;
  const parsed = settings.safeParse({ clientId: process.env.PRONTO_HOSTED_INSTAGRAM_CLIENT_ID,
    channelId: process.env.PRONTO_HOSTED_INSTAGRAM_CHANNEL_ID, accountId: process.env.PRONTO_HOSTED_INSTAGRAM_ACCOUNT_ID,
    marker: process.env.PRONTO_HOSTED_INSTAGRAM_DATABASE_MARKER,
    senderIds: process.env.PRONTO_HOSTED_INSTAGRAM_SENDER_IDS?.split(",").map(value => value.trim()) });
  if (!parsed.success || process.env.PRONTO_HOSTED_INSTAGRAM !== "1" ||
      process.env.PRONTO_DEPLOYMENT_PROFILE !== "standard" || process.env.PRONTO_USE_MOCK_AI !== "0" ||
      process.env.PRONTO_CUSTOMER_DEMO_ENABLED !== "0" || process.env.PRONTO_DEMO_ONLY_DELIVERY !== "0" ||
      parsed.data.senderIds.includes(parsed.data.accountId))
    throw new LlmConfigurationError("groq", "The isolated Instagram test AI scope is invalid.");
  return parsed.data;
}

async function verifyDatabase(marker: string) {
  const { rows: [identity] } = await query<{ safe: boolean }>(
    "select shobj_description(oid,'pg_database')=$1 as safe from pg_database where datname=current_database()", [marker]);
  if (!identity?.safe) throw new LlmConfigurationError("groq", "Instagram test database identity verification failed.");
}

// Authoring still requires source review, exact draft approval and publication.
export async function usesInstagramTestTextKnowledge(clientId: string): Promise<boolean> {
  const config = instagramTestAiConfiguration();
  if (!config || config.clientId !== clientId) return false;
  await verifyDatabase(config.marker);
  const { rows: [channel] } = await query<Channel>(
    `select c.* from channels c join instagram_test_knowledge_scopes s on s.channel_id=c.id and s.client_id=c.client_id
     where c.client_id=$1 and c.id=$2 and s.database_marker=$3`, [clientId, config.channelId, config.marker]);
  if (!channel || channel.kind !== "instagram" || channel.settings.authMode !== "unified_login" ||
      channel.external_id !== config.accountId || !channel.encrypted_credentials)
    throw new LlmConfigurationError("groq", "Instagram test channel identity verification failed.");
  return true;
}

export async function instagramTestAiProfile(channel: Channel, senderId: string): Promise<AiExecutionProfile | null> {
  const config = instagramTestAiConfiguration();
  if (process.env.PRONTO_HOSTED_INSTAGRAM !== "1" || channel.kind !== "instagram") return null;
  if (!config || channel.client_id !== config.clientId || channel.id !== config.channelId ||
      channel.status !== "active" || channel.settings.authMode !== "unified_login" ||
      channel.external_id !== config.accountId || channel.credentials.igUserId !== config.accountId ||
      !channel.encrypted_credentials || !config.senderIds.includes(senderId))
    throw new LlmConfigurationError("groq", "Instagram test requires its approved channel and allowlisted tester.");
  await usesInstagramTestTextKnowledge(config.clientId);
  const { rows: [published] } = await query<{ response_provider: string; response_model: string;
    embedding_provider: string; embedding_model: string }>(
    "select response_provider,response_model,embedding_provider,embedding_model from agent_configs where client_id=$1", [config.clientId]);
  if (published?.response_provider !== "groq" || published.response_model !== instagramTestModel ||
      published.embedding_provider !== "none" || published.embedding_model !== "none" ||
      !envApiKeyForProvider("groq") || process.env.PRONTO_GROQ_FREE_TIER_CONFIRMED !== "1" ||
      !await hasApprovedTextKnowledge(config.clientId))
    throw new LlmConfigurationError("groq", "Instagram test requires published model settings, approved knowledge and its free-tier key.");
  return { mode: "real", provider: "groq", model: instagramTestModel, embeddingProvider: "none",
    embeddingModel: "none", retrievalMode: "local_text", instagramTestClientId: config.clientId };
}

export async function assertInstagramTestAiReady(): Promise<void> {
  const config = instagramTestAiConfiguration();
  if (!config) throw new LlmConfigurationError("groq", "Instagram test AI is not configured.");
  const { rows: [channel] } = await query<Channel>(
    "select * from channels where client_id=$1 and id=$2", [config.clientId, config.channelId]);
  if (!channel) throw new LlmConfigurationError("groq", "Instagram test channel is unavailable.");
  await instagramTestAiProfile(decryptChannelCredentials(channel), config.senderIds[0]);
}
