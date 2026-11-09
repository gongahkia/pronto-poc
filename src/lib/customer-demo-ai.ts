import { query } from "@/lib/db";
import { selectModel } from "@/lib/llm/catalog";
import { envApiKeyForProvider } from "@/lib/llm/credentials";
import { DemoError, DEMO_CLIENT_ID } from "@/lib/customer-demo-boundary";
import type { AgentConfig } from "@/lib/types";
import { demoModelChoice, demoModelChoices, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_PROFILE,
  type DemoAiProfile } from "@/lib/llm/demo-models";
import { freeProviderRequirements } from "@/lib/llm/free-providers";
import { hasApprovedTextKnowledge } from "@/lib/knowledge/retrieve";
import { protectedDemoDeployment } from "@/lib/deployment-profile";

export function localOpenAiDemoEnabled(): boolean {
  return process.env.PRONTO_DEMO_LOCAL_OPENAI === "1" &&
    process.env.NODE_ENV !== "production" && !protectedDemoDeployment();
}

export function profileForDemoChoice(value: unknown): DemoAiProfile | undefined {
  const choice = demoModelChoice(value);
  if (!choice) throw new DemoError("Choose a supported demo model.");
  if (choice.id === "configured" || choice.id === "mock") return undefined;
  if (choice.id === "openai-local") {
    if (!localOpenAiDemoEnabled()) throw new DemoError("Local OpenAI evaluation is not enabled.", 403);
    return { provider: "openai", model: choice.model,
      embeddingProvider: "none", embeddingModel: "none", retrievalMode: "local_text" };
  }
  if (choice.id === "groq-oss") return { provider: "groq", model: choice.model,
    embeddingProvider: "none", embeddingModel: "none", retrievalMode: "local_text" };
  return { provider: choice.provider, model: choice.model, embeddingProvider: "gemini", embeddingModel: GEMINI_EMBEDDING_MODEL };
}

export function storedDemoProfile(session: { ai_selection: string; ai_configuration: DemoAiProfile | null }): DemoAiProfile | undefined {
  const expected = profileForDemoChoice(session.ai_selection);
  if (expected && (!session.ai_configuration || Object.entries(expected).some(([key,value]) =>
    session.ai_configuration?.[key as keyof DemoAiProfile] !== value)))
    throw new DemoError("The stored demo model configuration is invalid. Start a new conversation.", 503);
  return session.ai_configuration ?? expected;
}

export function realDemoConfiguration(config: AgentConfig, profile?: DemoAiProfile) {
  const provider = profile?.provider ?? process.env.PRONTO_LLM_PROVIDER ?? config.response_provider;
  const embeddingProvider = profile?.embeddingProvider ?? process.env.PRONTO_EMBEDDING_PROVIDER ?? config.embedding_provider;
  const localText = profile?.retrievalMode === "local_text" &&
    (profile.provider === "groq" || (profile.provider === "openai" && localOpenAiDemoEnabled())) &&
    embeddingProvider === "none" && profile.embeddingModel === "none";
  const missing: string[] = [];
  if (localText && profile?.provider === "openai" && process.env.PRONTO_DEMO_REAL_AI_APPROVED !== "1")
    missing.push("PRONTO_DEMO_REAL_AI_APPROVED=1");
  for (const current of new Set([provider, embeddingProvider])) {
    if (current === "none" && localText) continue;
    if (current === "gemini" || current === "groq") missing.push(...freeProviderRequirements(current));
    else if (!["openai", "azure", "anthropic"].includes(current))
      missing.push("a real provider (mock is not allowed)");
    else if (!envApiKeyForProvider(current)) missing.push(current === "openai" ? "OPENAI_API_KEY" :
      current === "azure" ? "AZURE_OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    if (current === "azure") {
      for (const name of ["AZURE_OPENAI_ENDPOINT", ...(embeddingProvider === "azure" ? ["AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] : [])])
        if (!process.env[name]?.trim()) missing.push(name);
      if (provider === "azure" && !process.env.AZURE_OPENAI_RESPONSE_DEPLOYMENT?.trim() && !process.env.AZURE_OPENAI_DEPLOYMENT?.trim())
        missing.push("AZURE_OPENAI_RESPONSE_DEPLOYMENT or AZURE_OPENAI_DEPLOYMENT");
    }
  }
  if (!localText && !["openai", "azure", "gemini"].includes(embeddingProvider)) missing.push("PRONTO_EMBEDDING_PROVIDER=openai or azure or gemini");
  const choice = selectModel({ provider, configuredModel: profile?.model ??
    (["gemini", "groq"].includes(provider) ? undefined : config.response_model), task: "agent_answer", ignoreEnvironment: Boolean(profile) });
  return { provider, model: choice.model, embeddingProvider,
    embeddingModel: profile?.embeddingModel ?? process.env.PRONTO_EMBEDDING_MODEL ??
      (embeddingProvider === "gemini" ? GEMINI_EMBEDDING_MODEL : config.embedding_model),
    ...(localText ? { retrievalMode: "local_text" as const } : {}), missing: [...new Set(missing)] };
}

export async function requireRealDemoConfiguration(requireKnowledge = true, profile?: DemoAiProfile) {
  const result = await query<AgentConfig>("select * from agent_configs where client_id=$1", [DEMO_CLIENT_ID]);
  if (!result.rows[0]) throw new DemoError("Set up the PS.Cafe demo tenant first.", 503);
  const config = realDemoConfiguration(result.rows[0], profile);
  if (config.missing.length) throw new DemoError(`Real AI is unavailable. Configure ${config.missing.join(", ")} securely on the server.`, 503);
  if (requireKnowledge) {
    if (config.retrievalMode === "local_text") {
      if (!await hasApprovedTextKnowledge(DEMO_CLIENT_ID))
        throw new DemoError("No approved published demo knowledge is available for local text retrieval. Review and publish knowledge through the existing approval workflow.", 503);
      return config;
    }
    if (config.embeddingProvider === "gemini") {
      const prepared = await query<{ total: number; prepared: number }>(`select count(*)::int as total,
        count(e.chunk_id)::int as prepared from knowledge_chunks k
        join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
        left join customer_demo_embeddings e on e.chunk_id=k.id and e.client_id=k.client_id
          and e.model=$2 and e.profile=$3 and e.content_hash=encode(sha256(convert_to(k.content,'UTF8')),'hex')
        where k.client_id=$1 and coalesce(s.metadata->>'archived','false')<>'true'`,
        [DEMO_CLIENT_ID, config.embeddingModel, GEMINI_EMBEDDING_PROFILE]);
      if (!prepared.rows[0]?.total || prepared.rows[0].total !== prepared.rows[0].prepared)
        throw new DemoError("Real AI knowledge is not prepared. Run demo:customer:embed --provider gemini for current published demo knowledge.", 503);
      return config;
    }
    const chunks = await query<{ count: string }>(`select count(*) from knowledge_chunks k
      join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
      where k.client_id=$1 and k.metadata->>'embeddingProvider'=$2 and k.embedding_model=$3
      and coalesce(s.metadata->>'archived','false')<>'true'`,
      [DEMO_CLIENT_ID, config.embeddingProvider, config.embeddingModel]);
    if (Number(chunks.rows[0]?.count ?? 0) === 0)
      throw new DemoError("Real AI knowledge is not prepared. Run the guarded demo:customer:embed command; mock vectors are not real embeddings.", 503);
  }
  return config;
}

export async function demoModelAvailability() {
  return Promise.all(demoModelChoices.filter(choice => choice.id !== "openai-local" || localOpenAiDemoEnabled()).map(async choice => {
    if (choice.id === "mock") return { ...choice, available: true, detail: "Deterministic test; no inference provider is called." };
    try { const config = await requireRealDemoConfiguration(true, profileForDemoChoice(choice.id));
      return { ...choice, provider: config.provider, model: config.model, available: true,
        detail: "Configured. Actual inference is labelled on each delivered reply; account billing and limits require separate verification." };
    } catch (error) { return { ...choice, available: false, detail: error instanceof DemoError ? error.message : "Model configuration could not be checked." }; }
  }));
}
