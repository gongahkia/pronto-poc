import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { enterTenantContext } from "@/lib/tenant-context";
import { canViewBusinessConversation } from "@/lib/staff-permissions";
import { selfServeUIEnabled } from "@/lib/self-serve/settings";
import { getHandoverSummary } from "@/lib/self-serve/handover-summary";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});
export async function GET() {
  if (!selfServeUIEnabled()) return json({ error: "Self-serve is not enabled." }, 404);
  const actor = await getSessionUser();
  if (!actor) return json({ error: "Sign in to continue." }, 401);
  if (actor.role !== "client" || !actor.clientId) return json({ error: "Business membership required." }, 403);
  enterTenantContext(actor);
  if (!await canViewBusinessConversation(actor, actor.clientId))
    return json({ error: "Conversation access required." }, 403);
  return json(await getHandoverSummary(actor.clientId));
}
