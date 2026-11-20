import { customerSimulatorEnabled } from "@/lib/customer-simulator-policy";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http/csrf";
import { assertDemoActor, createDemoSession, getDemoState, sendDemoMessage, retryDemoProcessing } from "@/lib/customer-demo";
import { DemoError } from "@/lib/customer-demo-boundary";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request, mutate: boolean) {
  if (!customerSimulatorEnabled()) return NextResponse.json({ error: "Customer simulation is disabled." }, { status: 404 });
  if (mutate) { const csrf = assertSameOrigin(request); if (csrf) return csrf; }
  const actor = await getSessionUser();
  if (!actor) return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  try {
    await assertDemoActor(actor);
    if (!mutate) return NextResponse.json(await getDemoState(actor,
      new URL(request.url).searchParams.get("sessionId") ?? undefined), { headers: { "Cache-Control": "no-store" } });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 16_384) throw new DemoError("Message request is too large.", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { throw new DemoError("Invalid request."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DemoError("Invalid request.");
    if (body.action === "create" && (body.mode !== "real" || body.choice === "mock" || body.choice === "configured"))
      throw new DemoError("Choose an available real AI model. Simulated replies are disabled.");
    if (body.action === "create" && body.mode === "real") {
      if (Object.keys(body).some(key => !["action","mode","choice"].includes(key))) throw new DemoError("Only allowlisted demo model choices are accepted.");
      return NextResponse.json(body.choice === undefined ? await createDemoSession(actor, body.mode)
        : await createDemoSession(actor, body.mode, body.choice), { status: 201 });
    }
    if (body.action === "send" && typeof body.sessionId === "string" && typeof body.requestId === "string" && typeof body.text === "string")
      return NextResponse.json(await sendDemoMessage(actor, { sessionId: body.sessionId, requestId: body.requestId, text: body.text }), { status: 202 });
    if (body.action === "retry" && typeof body.sessionId === "string") {
      await retryDemoProcessing(actor, body.sessionId); return NextResponse.json({ queued: true }, { status: 202 });
    }
    throw new DemoError("Unsupported customer-demo request.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof DemoError ? error.message : "The customer demo could not complete this request. Please retry." },
      { status: error instanceof DemoError ? error.status : 500 });
  }
}
export async function GET(request: Request) { return handle(request, false); }
export async function POST(request: Request) { return handle(request, true); }
