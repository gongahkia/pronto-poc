import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http/csrf";
import { canViewBusinessConversation } from "@/lib/staff-permissions";
import { refreshInstagramConversationProfile } from "@/lib/channels/instagram-profile";

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;
  const actor = await getSessionUser();
  if (!actor)
    return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  if (
    actor.role !== "client" ||
    !actor.clientId ||
    !(await canViewBusinessConversation(actor, actor.clientId))
  )
    return NextResponse.json(
      { error: "Conversation access required." },
      { status: 403 },
    );
  const { conversationId } = await context.params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      conversationId,
    )
  )
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  if (request.body) {
    const reader = request.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    if (first.value?.byteLength)
      return NextResponse.json(
        { error: "This request takes no parameters." },
        { status: 400 },
      );
  }
  try {
    const status = await refreshInstagramConversationProfile(
      actor.clientId,
      conversationId,
    );
    return NextResponse.json(
      { status },
      {
        status: status === "not_found" ? 404 : 200,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Profile details are temporarily unavailable." },
      { status: 503 },
    );
  }
}
