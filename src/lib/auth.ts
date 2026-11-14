import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { recordAuditLog } from "@/lib/audit";
import { query } from "@/lib/db";
import { appBaseUrl } from "@/lib/env";
import { verifyPassword } from "@/lib/password";
import { enterTenantContext } from "@/lib/tenant-context";
import {
  SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, decodeSession, encodeSession,
  type SessionUser,
} from "@/lib/session-token";
import type { User, UserRole } from "@/lib/types";

const COOKIE_NAME = SESSION_COOKIE_NAME;

export type { SessionUser };

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  return getSessionUserFromToken(cookieStore.get(COOKIE_NAME)?.value);
}

// revalidate a request's captured cookie during streaming without relying on Next request-local APIs.
export async function getSessionUserFromToken(cookieValue: string | undefined): Promise<SessionUser | null> {
  const payload = decodeSession(cookieValue);
  if (!payload) {
    return null;
  }

  const result = await query<User>(
    "select * from users where id = $1 and session_version = $2",
    [payload.userId, payload.sv],
  );
  const currentUser = result.rows[0];
  if (!currentUser) {
    return null;
  }

  return {
    userId: currentUser.id,
    email: currentUser.email,
    name: currentUser.name,
    role: currentUser.role,
    clientId: currentUser.client_id,
  };
}

export async function requireUser(role?: UserRole): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(role === "client" ? "/login?next=/client/inbox" : "/login");
  if (role && user.role !== role) redirect(role === "client"
    ? "/access?reason=business-role" : "/access?reason=operator-role");
  enterTenantContext(user);
  return user;
}

export async function establishSession(
  user: Pick<User, "id" | "email" | "name" | "role" | "client_id" | "session_version">,
): Promise<SessionUser> {
  const sessionUser: SessionUser = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clientId: user.client_id,
  };
  const cookieStore = await cookies();
  cookieStore.set(
    COOKIE_NAME,
    encodeSession({
      ...sessionUser,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      sv: user.session_version,
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && appBaseUrl().startsWith("https://"),
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    },
  );
  return sessionUser;
}

export async function login(email: string, password: string): Promise<SessionUser | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const result = await query<User>("select * from users where email = $1", [
    normalizedEmail,
  ]);
  const user = result.rows[0];
  if (!user) {
    await recordAuditLog({
      clientId: null,
      actorUserId: null,
      action: "auth.login_failed",
      targetType: "user",
      metadata: { email: normalizedEmail, reason: "user_not_found" },
    });
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await recordAuditLog({
      clientId: user.client_id,
      actorUserId: user.id,
      action: "auth.login_failed",
      targetType: "user",
      targetId: user.id,
      metadata: { email: user.email, reason: "invalid_password" },
    });
    return null;
  }

  const sessionUser = await establishSession(user);

  await recordAuditLog({
    clientId: user.client_id,
    actorUserId: user.id,
    action: "auth.login_succeeded",
    targetType: "user",
    targetId: user.id,
    metadata: { email: user.email, role: user.role },
  });

  return sessionUser;
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
