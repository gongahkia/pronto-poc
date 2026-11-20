import { randomUUID } from "node:crypto";
import { query } from "@/lib/db";
import { metaGraphVersion } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { protectedDemoDeployment } from "@/lib/deployment-profile";
import { getInstagramChannel, isInstagramTokenExpired } from "./instagram";
import { assertDemoInstagramScope } from "./instagram-demo";
import { instagramTestAiProfile } from "./instagram-test-ai";
import { parseInstagramProfile, type InstagramCustomerProfile } from "./instagram-profile-data";

const fields = "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user";
export async function fetchInstagramCustomerProfile(input: { senderId: string; token: string; direct: boolean }): Promise<InstagramCustomerProfile> {
  if (!/^\d{1,40}$/.test(input.senderId) || !input.token) throw Error("Profile configuration unavailable.");
  const version = metaGraphVersion();
  if (!/^v\d+\.\d+$/.test(version)) throw Error("Profile configuration unavailable.");
  const url = new URL(`https://${input.direct ? "graph.instagram.com" : "graph.facebook.com"}/${version}/${input.senderId}`);
  url.searchParams.set("fields", fields);
  const response = await fetch(url, { headers: { Authorization: "Bearer " + input.token }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  if (!response.ok) { await response.body?.cancel(); throw Error("Profile lookup unavailable."); }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Profile lookup unavailable.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 32768) { await reader.cancel(); throw Error("Profile response too large."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || (data.id !== undefined && String(data.id) !== input.senderId)) throw Error("Profile identity mismatch.");
  const profile = parseInstagramProfile(data);
  if (!profile) throw Error("Profile details unavailable.");
  return profile;
}

// Profile data is display-only. The scoped sender ID and routing fields never change.
export async function refreshInstagramConversationProfile(clientId: string, conversationId: string): Promise<"refreshed" | "cached" | "unavailable" | "not_found"> {
  const lease = randomUUID();
  const claimed = await query<{ channel_id: string; external_thread_id: string }>(
    `update conversations c set instagram_profile_lease_token=$3,instagram_profile_lease_until=now()+interval '30 seconds'
     from channels ch where c.client_id=$1 and c.id=$2 and c.deleted_at is null
       and ch.id=c.channel_id and ch.client_id=$1 and ch.kind='instagram' and ch.status='active'
       and c.instagram_profile_refresh_after<=now() and (c.instagram_profile_lease_until is null or c.instagram_profile_lease_until<=now())
     returning c.channel_id,c.external_thread_id`, [clientId, conversationId, lease]);
  if (!claimed.rows[0]) {
    const found = await query("select c.id from conversations c join channels ch on ch.id=c.channel_id and ch.client_id=c.client_id where c.id=$2 and c.client_id=$1 and c.deleted_at is null and ch.kind='instagram'", [clientId,conversationId]);
    return found.rowCount ? "cached" : "not_found";
  }
  const { channel_id: channelId, external_thread_id: senderId } = claimed.rows[0];
  try {
    const channel = await getInstagramChannel(channelId, clientId);
    if (!channel || channel.status !== "active") throw Error("Channel unavailable.");
    if (protectedDemoDeployment()) await assertDemoInstagramScope(channel, senderId);
    else if (process.env.PRONTO_HOSTED_INSTAGRAM === "1") await instagramTestAiProfile(channel, senderId);
    const direct = channel.settings.authMode === "instagram_login", unified = channel.settings.authMode === "unified_login";
    if (channel.settings.authMode && !["facebook_login","instagram_login","unified_login"].includes(String(channel.settings.authMode))) throw Error("Channel unavailable.");
    if (isInstagramTokenExpired(channel)) throw Error("Channel unavailable.");
    const token = channel.credentials[unified ? "accessToken" : direct ? "instagramAccessToken" : "pageAccessToken"];
    if (typeof token !== "string") throw Error("Channel unavailable.");
    const profile = await fetchInstagramCustomerProfile({ senderId, token, direct });
    const saved = await query(
      `update conversations c set instagram_profile=$4,instagram_profile_refresh_after=now()+interval '1 day',
       instagram_profile_lease_token=null,instagram_profile_lease_until=null
       where c.client_id=$1 and c.id=$2 and c.instagram_profile_lease_token=$3 and c.external_thread_id=$5 and c.deleted_at is null
       and exists(select 1 from channels ch where ch.id=c.channel_id and ch.client_id=$1 and ch.status='active'
         and ch.external_id is not distinct from $6 and ch.encrypted_credentials is not distinct from $7)`,
      [clientId,conversationId,lease,profile,senderId,channel.external_id,channel.encrypted_credentials ?? null]);
    return saved.rowCount ? "refreshed" : "unavailable";
  } catch {
    await query(`update conversations set instagram_profile_refresh_after=now()+interval '15 minutes',
      instagram_profile_lease_token=null,instagram_profile_lease_until=null where client_id=$1 and id=$2 and instagram_profile_lease_token=$3`, [clientId,conversationId,lease]);
    logWarn("instagram.profile_lookup_unavailable", { clientId, conversationId, channelId });
    return "unavailable";
  }
}

export async function refreshInstagramSenderProfiles(clientId: string, channelId: string, senderIds: string[]): Promise<void> {
  // Bound provider work per webhook; opening any omitted thread can hydrate it too.
  for (const senderId of [...new Set(senderIds)].slice(0,5)) {
    const result = await query<{ id: string }>("select id from conversations where client_id=$1 and channel_id=$2 and external_thread_id=$3 and deleted_at is null", [clientId,channelId,senderId]);
    if (result.rows[0]) await refreshInstagramConversationProfile(clientId,result.rows[0].id);
  }
}
