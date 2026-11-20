import {whatsAppOwnerEchoes,recordNativeOwnerReply} from '@/lib/self-serve/owner-replies';
import { NextResponse } from "next/server";
import {
  getWhatsAppChannel,
  normalizeWhatsAppPayload,
  recordWhatsAppStatusEvents,
  verifyWhatsAppSignature,
  whatsAppPayloadMatchesChannel,
} from "@/lib/channels/whatsapp";
import { processInboundMessages } from "@/lib/channels/process";
import { isBodyWithinLimit } from "@/lib/http-limits";
import { requestIdFromRequest, requestIdHeaders } from "@/lib/logger";

type Context = {
  params: Promise<{ channelId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  const channel = await getWhatsAppChannel(channelId);
  if (!channel) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (channel.status !== "active") return new NextResponse("Channel inactive", { status: 403 });

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = channel.settings.verifyToken as string | undefined;

  if (mode === "subscribe" && token === expected && challenge) {
    return new NextResponse(challenge);
  }

  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: Request, context: Context) {
  const requestId = requestIdFromRequest(request);
  const { channelId } = await context.params;
  const channel = await getWhatsAppChannel(channelId);
  if (!channel) {
    return new NextResponse("Not found", {
      status: 404,
      headers: requestIdHeaders(requestId),
    });
  }
  if (channel.status !== "active") return new NextResponse("Channel inactive", { status: 403, headers: requestIdHeaders(requestId) });

  const rawBody = await request.text();
  if (!isBodyWithinLimit(rawBody)) {
    return new NextResponse("Payload too large", {
      status: 413,
      headers: requestIdHeaders(requestId),
    });
  }

  const appSecret = channel.credentials.appSecret as string | undefined;

  if (
    !verifyWhatsAppSignature(
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
  const phoneNumberId = (channel.credentials.phoneNumberId as string | undefined) ?? channel.external_id;
  if (!phoneNumberId || !whatsAppPayloadMatchesChannel(payload, phoneNumberId)) {
    return new NextResponse("Business number mismatch", { status: 403, headers: requestIdHeaders(requestId) });
  }
  for(const echo of whatsAppOwnerEchoes(payload,phoneNumberId))await recordNativeOwnerReply(channel,echo);
  await recordWhatsAppStatusEvents(channel, payload);
  const messages = normalizeWhatsAppPayload(channelId, payload);
  return NextResponse.json(await processInboundMessages(messages, { requestId }), {
    headers: requestIdHeaders(requestId),
  });
}
