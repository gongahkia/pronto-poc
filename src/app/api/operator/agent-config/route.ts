import { assertSameOrigin } from "@/lib/http/csrf";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { stageAgentConfig } from "@/lib/assistant-drafts";
import { logWarn } from "@/lib/logger";
import { canAccessClient } from "@/lib/rbac";
import { instagramTestModel, usesInstagramTestTextKnowledge } from "@/lib/channels/instagram-test-ai";

export async function POST(request: Request) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const user = await requireUser("operator");
  const form = await request.formData();
  const clientId = String(form.get("clientId") ?? "");
  const promptPreamble = String(form.get("promptPreamble") ?? "").trim();
  const escalationRulesJson = String(form.get("escalationRules") ?? "").trim();
  const changeReason = String(form.get("changeReason") ?? "").trim();
  const responseProvider = String(form.get("responseProvider") ?? "openai").trim();
  const responseModel = String(form.get("responseModel") ?? "").trim();
  const embeddingProvider = String(form.get("embeddingProvider") ?? "openai").trim();
  const embeddingModel = String(form.get("embeddingModel") ?? "").trim();

  if (!clientId) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }
  if (!canAccessClient(user, clientId)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const instagramTest = (responseProvider === "groq" || embeddingProvider === "none") &&
    await usesInstagramTestTextKnowledge(clientId);
  if (instagramTest && (responseProvider !== "groq" || responseModel !== instagramTestModel ||
      embeddingProvider !== "none" || embeddingModel !== "none"))
    return NextResponse.json({ error: "The Instagram test requires the configured Groq model and local text retrieval." }, { status: 400 });
  if (!isAllowedResponseProvider(responseProvider) && !instagramTest) {
    logWarn("agent_config.invalid_response_provider", {
      actorUserId: user.userId,
      clientId,
      responseProvider,
    });
    return NextResponse.json({ error: "Response provider is not supported." }, { status: 400 });
  }

  if (!["mock", "openai", "azure"].includes(embeddingProvider) && !instagramTest) {
    logWarn("agent_config.invalid_embedding_provider", {
      actorUserId: user.userId,
      clientId,
      embeddingProvider,
    });
    return NextResponse.json({ error: "Embedding provider must be mock, openai, or azure." }, { status: 400 });
  }

  if (!isSafeModelName(responseModel) || !isSafeModelName(embeddingModel)) {
    return NextResponse.json(
      { error: "Provider model names are required and must be 160 characters or fewer." },
      { status: 400 },
    );
  }

  const retrievalThreshold = Number(String(form.get("retrievalThreshold") ?? ""));
  if (!Number.isFinite(retrievalThreshold) || retrievalThreshold < 0 || retrievalThreshold > 1) {
    logWarn("agent_config.invalid_retrieval_threshold", {
      actorUserId: user.userId,
      clientId,
      retrievalThreshold: String(form.get("retrievalThreshold") ?? ""),
    });
    return NextResponse.json(
      { error: "Retrieval threshold must be a number from 0 to 1." },
      { status: 400 },
    );
  }

  if (!promptPreamble || promptPreamble.length > 4000) {
    return NextResponse.json(
      { error: "Prompt preamble is required and must be 4000 characters or fewer." },
      { status: 400 },
    );
  }

  let escalationRules: Record<string, unknown>;
  try {
    escalationRules = parseJsonObject(escalationRulesJson || "{}");
  } catch (error) {
    logWarn("agent_config.invalid_escalation_rules_json", {
      actorUserId: user.userId,
      clientId,
      error,
    });
    return NextResponse.json(
      { error: "Escalation rules must be a valid JSON object." },
      { status: 400 },
    );
  }

  await stageAgentConfig({
    clientId,
    responseProvider,
    responseModel,
    embeddingProvider,
    embeddingModel,
    retrievalThreshold,
    promptPreamble,
    escalationRules,
    actorUserId: user.userId,
    changeReason,
  });
  return NextResponse.json({ ok: true, clientId });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}


function isAllowedResponseProvider(value: string): boolean {
  return (
    value === "mock" ||
    value === "openai" ||
    value === "azure" ||
    value === "anthropic"
  );
}

function isSafeModelName(value: string): boolean {
  return Boolean(value) && value.length <= 160 && /^[a-zA-Z0-9_.:/@+-]+$/.test(value);
}
