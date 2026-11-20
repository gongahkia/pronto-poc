export type InstagramCustomerProfile = {
  name?: string;
  username?: string;
  photoUrl?: string;
  followerCount?: number;
  verified?: boolean;
  followsBusiness?: boolean;
  businessFollowsCustomer?: boolean;
};

export function instagramPhotoUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["cdninstagram.com", "fbcdn.net", "fbsbx.com"].some(domain => host === domain || host.endsWith("." + domain)) ||
      [...url.searchParams.keys()].some(key => /^(access_token|token|secret|authorization|appsecret_proof)$/i.test(key))) return;
    return url.href;
  } catch { return; }
}

export function parseInstagramProfile(value: unknown): InstagramCustomerProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>, result: InstagramCustomerProfile = {};
  if (typeof input.name === "string" && input.name.trim() && input.name.length <= 120)
    result.name = input.name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (typeof input.username === "string" && /^[a-zA-Z0-9._]{1,30}$/.test(input.username)) result.username = input.username;
  const photo = instagramPhotoUrl(input.profile_pic);
  if (photo) result.photoUrl = photo;
  if (typeof input.follower_count === "number" && Number.isSafeInteger(input.follower_count) && input.follower_count >= 0) result.followerCount = input.follower_count;
  if (typeof input.is_verified_user === "boolean") result.verified = input.is_verified_user;
  if (typeof input.is_user_follow_business === "boolean") result.followsBusiness = input.is_user_follow_business;
  if (typeof input.is_business_follow_user === "boolean") result.businessFollowsCustomer = input.is_business_follow_user;
  return result.name || result.username ? result : null;
}

type CustomerIdentity = { customer_name: string | null; customer_handle: string | null; channel_kind?: string;
  instagram_profile?: InstagramCustomerProfile };
export function customerDisplayName(conversation: CustomerIdentity): string {
  const profile = conversation.channel_kind === "instagram" ? conversation.instagram_profile : undefined;
  return profile?.name || conversation.customer_name || (profile?.username ? "@" + profile.username : conversation.customer_handle) || "Customer";
}
export function customerDisplayHandle(conversation: CustomerIdentity): string | null {
  if (conversation.channel_kind !== "instagram") return null;
  const username = conversation.instagram_profile?.username;
  return username ? "@" + username : null;
}
