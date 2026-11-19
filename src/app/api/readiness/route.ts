import { NextResponse } from "next/server";
import { appBaseUrl, shouldUseMockAi } from "@/lib/env";
import { getPool } from "@/lib/db";
import { protectedDemoDeployment,requestDrivenDemoProcessing } from "@/lib/deployment-profile";
import {getDemoProcessingStatus} from '@/lib/demo-processing-status';
import { assertCustomerDemoEnabled } from "@/lib/customer-demo-boundary";
import { requireRealDemoConfiguration, profileForDemoChoice } from "@/lib/customer-demo-ai";
import { DEFAULT_DEMO_MODEL } from "@/lib/llm/demo-models";
import { assertInstagramTestAiReady } from "@/lib/channels/instagram-test-ai";
import { assertDemoInstagramReady } from "@/lib/channels/instagram-demo";

type ReadinessCheck = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

export async function GET() {
  const checks: ReadinessCheck[] = [];
  let demoIdentityVerified = false;
  if (protectedDemoDeployment()) {
    try { await assertCustomerDemoEnabled(); demoIdentityVerified = true;
      checks.push({ name: "Demo identity", status: "pass", detail: "Protected demo identity verified." }); }
    catch { checks.push({ name: "Demo identity", status: "fail", detail: "Protected demo identity/configuration failed." }); }
  }

  checks.push(secretCheck("AUTH_SECRET"));
  checks.push(secretCheck("PRONTO_SECRETS_KEY"));
  checks.push({
    name: "APP_BASE_URL",
    status:
      process.env.NODE_ENV === "production" && !appBaseUrl().startsWith("https://")
        ? "fail"
        : "pass",
    detail: appBaseUrl().startsWith("https://")
      ? "Public HTTPS base URL is configured."
      : "Non-HTTPS base URL is allowed outside production only.",
  });
  checks.push({
    name: "PRONTO_USE_MOCK_AI",
    status:
      process.env.NODE_ENV === "production" && shouldUseMockAi() ? "fail" : "pass",
    detail: shouldUseMockAi()
      ? "Mock AI is enabled."
      : "Mock AI override is disabled.",
  });
  checks.push({
    name: "Tenant SQL gate",
    status:
      process.env.NODE_ENV === "production" &&
      process.env.PRONTO_DISABLE_TENANT_SQL_GATE === "1"
        ? "fail"
        : "pass",
    detail:
      process.env.PRONTO_DISABLE_TENANT_SQL_GATE === "1"
        ? "Tenant SQL gate is disabled."
        : "Tenant SQL gate is enabled or environment-enforced.",
  });

  try {
    await getPool().query("select 1");
    checks.push({ name: "Database", status: "pass", detail: "Database is reachable." });
  } catch {
    checks.push({ name: "Database", status: "fail", detail: "Database is unavailable." });
  }
  if (checks.at(-1)?.status === "pass") {
    if (process.env.PRONTO_DEMO_INSTAGRAM_ENABLED === "1") {
      try { await assertDemoInstagramReady(); checks.push({ name: "Demo Instagram", status: "pass", detail: "Demo Instagram prerequisites are configured." }); }
      catch { checks.push({ name: "Demo Instagram", status: "fail", detail: "Demo Instagram prerequisites are unavailable." }); }
    }
    if (process.env.PRONTO_HOSTED_INSTAGRAM === "1") {
      try {
        await assertInstagramTestAiReady();
        checks.push({ name: "Instagram test AI", status: "pass", detail: "Scoped test prerequisites are configured." });
      } catch {
        checks.push({ name: "Instagram test AI", status: "fail", detail: "Scoped test prerequisites are unavailable." });
      }
    }
    if (demoIdentityVerified) {
      try {
        // Local configuration and published-knowledge checks only: no inference,
        // embedding call, or provider health request is made by this probe.
        await requireRealDemoConfiguration(true, profileForDemoChoice(DEFAULT_DEMO_MODEL));
        checks.push({ name: "Demo AI and knowledge", status: "pass", detail: "Demo prerequisites are configured." });
      } catch {
        checks.push({ name: "Demo AI and knowledge", status: "fail", detail: "Demo prerequisites are unavailable." });
      }
    }
    try {
      if(requestDrivenDemoProcessing()){
        const state=await getDemoProcessingStatus();
        checks.push({name:'Request processing',status:state.stopped?'fail':'pass',detail:state.stopped?'Saved demo work requires a retry.':'Authenticated request processing is configured; no continuous worker is expected.'});
      }else{
      const worker = await getPool().query<{ updated_at: Date }>(
        "select updated_at from worker_heartbeats where name = 'inbound-outbound'",
      );
      const heartbeat = worker.rows[0]?.updated_at;
      const fresh = Boolean(heartbeat && Date.now() - new Date(heartbeat).getTime() < 60_000);
      checks.push({ name: "Worker", status: fresh ? "pass" : "fail",
        detail: fresh ? "Inbound and outbound worker is running." : "Worker heartbeat is missing or stale." });
      }
    } catch {
      checks.push({ name: "Worker", status: "fail", detail: "Worker heartbeat is unavailable." });
    }
  }

  const ready = checks.every((check) => check.status === "pass");
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function secretCheck(name: "AUTH_SECRET" | "PRONTO_SECRETS_KEY"): ReadinessCheck {
  const value = process.env[name] ?? "";
  const strong = isStrongSecret(value);
  return {
    name,
    status: strong ? "pass" : "fail",
    detail: strong
      ? "Strong non-placeholder secret is configured."
      : `${name} must be at least 32 characters and non-placeholder.`,
  };
}

function isStrongSecret(value: string): boolean {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return (
    trimmed.length >= 32 &&
    new Set(trimmed).size >= 12 &&
    !lowered.startsWith("replace-with") &&
    !lowered.includes("change-me") &&
    !lowered.includes("placeholder")
  );
}
