import { refreshInstagramSenderProfiles } from "@/lib/channels/instagram-profile";
import {instagramOwnerEchoes,recordNativeOwnerReply} from '@/lib/self-serve/owner-replies';
import {demoBusinessScope} from "@/lib/demo-business";
import { after, NextResponse } from "next/server";
import {
  getInstagramChannel,
  instagramPayloadMatchesChannel,
  normalizeInstagramPayload,
  verifyInstagramSignature,
} from "@/lib/channels/instagram";
import { processInboundMessages } from "@/lib/channels/process";
import { isBodyWithinLimit } from "@/lib/http-limits";
import { logInfo, requestIdFromRequest, requestIdHeaders } from "@/lib/logger";
import { instagramProbeConfig, recordInstagramProbe } from "@/lib/channels/instagram-probe";
import { instagramTestAiProfile } from "@/lib/channels/instagram-test-ai";
import { isDemoInstagramChannel } from "@/lib/channels/instagram-demo";
import { protectedDemoDeployment } from "@/lib/deployment-profile";
import { logWarn } from "@/lib/logger";


export const maxDuration = 180;

type Context = {
  params: Promise<{ channelId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  const channel = await getInstagramChannel(channelId, protectedDemoDeployment() ? demoBusinessScope().clientId : undefined);
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
    return new NextResponse(challenge, { headers: { "Cache-Control": "no-store",
      ...(isDemoInstagramChannel(channel) ? { "X-Pronto-Instagram-Workspace": "public-demo" } : {}) } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: Request, context: Context) {
  const receivedAt = Date.now();
  const requestId = requestIdFromRequest(request);
  const { channelId } = await context.params;
  const channel = await getInstagramChannel(channelId, protectedDemoDeployment() ? demoBusinessScope().clientId : undefined);
  if (!channel) {
    return new NextResponse("Not found", {
      status: 404,
      headers: requestIdHeaders(requestId),
    });
  }
  const probe = instagramProbeConfig(channel);
  if (protectedDemoDeployment() && !isDemoInstagramChannel(channel))
    return new NextResponse("Channel outside demo scope", { status: 403, headers: requestIdHeaders(requestId) });
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
  const echoes=instagramOwnerEchoes(payload,igUserId,typeof channel.credentials.appId==='string'?channel.credentials.appId:undefined);
  try {
    for (const sender of new Set([...messages.map(message => message.externalThreadId),...echoes.map(echo=>echo.threadId)]))
      await instagramTestAiProfile(channel, sender);
  } catch {
    return new NextResponse("Instagram test scope unavailable", { status: 403, headers: requestIdHeaders(requestId) });
  }
  for(const echo of echoes)await recordNativeOwnerReply(channel,echo);
  const result = await processInboundMessages(messages, { requestId });
  const ages = messages.flatMap(message => {
    const timestamp = Date.parse(message.occurredAt ?? "");
    return Number.isFinite(timestamp) ? [Math.max(0, receivedAt - timestamp)] : [];
  });
  logInfo("instagram.webhook_ingested", { requestId, channelId, accepted: result.accepted,
    duplicates: result.duplicates, ingestionMs: Date.now() - receivedAt,
    oldestProviderAgeMs: ages.length ? Math.max(...ages) : null });
  if (result.jobIds.length) after(async () => {
    await Promise.allSettled([
      (async () => {
        if (!isDemoInstagramChannel(channel)) return;
        try { const { processDemoInstagramQueue } = await import("@/lib/demo-processing"); await processDemoInstagramQueue(channelId); }
        catch (error) { logWarn("instagram.demo_processing_interrupted", { channelId, error }); }
      })(),
      refreshInstagramSenderProfiles(channel.client_id, channelId, messages.map(message => message.externalThreadId))
        .catch(() => logWarn("instagram.profile_refresh_interrupted", { channelId })),
    ]);
  });
  return NextResponse.json(result, {
    headers: requestIdHeaders(requestId),
  });
}
