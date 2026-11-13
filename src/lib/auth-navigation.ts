import type { UserRole } from "@/lib/types";

// Post-login destinations are local application pages, never hosts or APIs.
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || !/^\/(?:client(?:\/[a-zA-Z0-9-]+)*|demo(?:\/customer)?|account)(?:\?[a-zA-Z0-9_=&-]*)?$/.test(value)) return null;
  return value;
}

export function signedInDestination(role: UserRole, returnTo?: unknown): string {
  const next = safeReturnTo(returnTo);
  if (role === "operator" && next?.startsWith("/client")) return "/access?reason=business-role";
  return next ?? (role === "operator" ? "/account" : "/client");
}
