import { NextResponse } from "next/server";
import {
  getInstagramChannel,
  instagramPayloadMatchesChannel,
  normalizeInstagramPayload,
  verifyInstagramSignature,
} from "@/lib/channels/instagram";
import { processInboundMessages } from "@/lib/channels/process";
import { isBodyWithinLimit } from "@/lib/http-limits";
import { requestIdFromRequest, requestIdHeaders } from "@/lib/logger";
import { instagramProbeConfig, recordInstagramProbe } from "@/lib/channels/instagram-probe";
import { instagramTestAiProfile } from "@/lib/channels/instagram-test-ai";

type Context = {
  params: Promise<{ channelId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  const channel = await getInstagramChannel(channelId);
  if (!channel) {
    return new NextResponse("Not found", { status: 404 });
  }
  // verify setup before activation; the receive-only probe is a separate opt-in.
  const preparingUnifiedLogin = channel.status === "draft" && channel.settings.authMode === "unified_login";
  if (channel.status !== "active" && !preparingUnifiedLogin)
    return new NextResponse("Channel inactive", { status: 403 });

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = channel.settings.verifyToken as string | undefined;

  if (mode === "subscribe" && typeof expected === "string" && expected.length > 0 && token === expected && challenge) {
    return new NextResponse(challenge, { headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: Request, context: Context) {
  const requestId = requestIdFromRequest(request);
  const { channelId } = await context.params;
  const channel = await getInstagramChannel(channelId);
  if (!channel) {
    return new NextResponse("Not found", {
      status: 404,
      headers: requestIdHeaders(requestId),
    });
  }
  const probe = instagramProbeConfig(channel);
  if (channel.status !== "active" && !probe) return new NextResponse("Channel inactive", { status: 403, headers: requestIdHeaders(requestId) });

  const rawBody = await request.text();
  if (!isBodyWithinLimit(rawBody)) {
    return new NextResponse("Payload too large", {
      status: 413,
      headers: requestIdHeaders(requestId),
    });
  }

  const appSecret = channel.credentials.appSecret as string | undefined;

  if (
    !verifyInstagramSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
      appSecret,
    )
  ) {
    return new NextResponse("Invalid signature", {
      status: 401,
      headers: requestIdHeaders(requestId),
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Invalid JSON", {
      status: 400,
      headers: requestIdHeaders(requestId),
    });
  }
  const igUserId = (channel.credentials.igUserId as string | undefined) ?? channel.external_id;
  if (!igUserId || !instagramPayloadMatchesChannel(payload, igUserId)) {
    return new NextResponse("Business account mismatch", { status: 403, headers: requestIdHeaders(requestId) });
  }
  const messages = normalizeInstagramPayload(channelId, payload);
  if (probe) {
    const observed = await recordInstagramProbe({ channel, rawBody,
      signature: request.headers.get("x-hub-signature-256") });
    return observed
      ? NextResponse.json({ ok: true, probe: true, duplicate: observed.duplicate },
        { headers: { ...requestIdHeaders(requestId), "Cache-Control": "no-store" } })
      : new NextResponse("Channel inactive", { status: 403, headers: requestIdHeaders(requestId) });
  }
  try {
    for (const sender of new Set(messages.map(message => message.externalThreadId)))
      await instagramTestAiProfile(channel, sender);
  } catch {
    return new NextResponse("Instagram test scope unavailable", { status: 403, headers: requestIdHeaders(requestId) });
  }
  return NextResponse.json(await processInboundMessages(messages, { requestId }), {
    headers: requestIdHeaders(requestId),
  });
}
