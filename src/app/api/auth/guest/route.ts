import { NextResponse } from "next/server";
import { establishSession } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth-navigation";
import { DemoError } from "@/lib/customer-demo-boundary";
import { createGuestReviewer } from "@/lib/guest-access";
import { guestAccessEnabled } from "@/lib/guest-policy";
import { assertSameOrigin } from "@/lib/http/csrf";
import { publicAppUrl } from "@/lib/http/redirect";

// Starts a reviewer session for the shared demo. Only exists on demo deployments (see guestAccessEnabled).
export async function POST(request: Request) {
  if (!guestAccessEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;
  const form = await request.formData();
  const returnTo = safeReturnTo(form.get("next"));
  const visitor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("user-agent") || "unknown";
  try {
    const user = await createGuestReviewer(form.get("name"), visitor);
    await establishSession(user);
  } catch (error) {
    if (error instanceof DemoError) {
      const back = publicAppUrl("/enter", request.url);
      back.searchParams.set("error", error.message);
      if (returnTo) back.searchParams.set("next", returnTo);
      return NextResponse.redirect(back, 303);
    }
    return NextResponse.json({ error: "Could not start a demo session. Please retry shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.redirect(publicAppUrl(returnTo ?? "/demo", request.url), 303);
}
