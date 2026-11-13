import { publicAppUrl } from "@/lib/http/redirect";
import { assertSameOrigin } from "@/lib/http/csrf";
import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getSessionUser, logout } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth-navigation";
import {guestAccessEnabled,isGuestEmail} from '@/lib/guest-policy';

export async function POST(request: Request) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const user = await getSessionUser();
  if (user) {
    await recordAuditLog({
      clientId: user.clientId,
      actorUserId: user.userId,
      action: "auth.logout",
      targetType: "user",
      targetId: user.userId,
      metadata: { role: user.role },
    });
  }
  await logout();
  const destination = publicAppUrl(user && isGuestEmail(user.email) && guestAccessEnabled() ? '/enter' : '/login', request.url);
  const form = await request.formData().catch(() => null);
  const returnTo = safeReturnTo(form?.get("next"));
  if (returnTo) destination.searchParams.set("next", returnTo);
  return NextResponse.redirect(destination, 303);
}
