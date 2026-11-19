import {demoBusinessScope} from "@/lib/demo-business";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { recordAuditLog } from "@/lib/audit";
import { query, transaction } from "@/lib/db";
import { staffCapabilities } from "@/lib/staff-permissions";
import { DemoError } from "@/lib/customer-demo-boundary";
import { GUEST_EMAIL_DOMAIN } from "@/lib/guest-policy";
import type { User } from "@/lib/types";

const MAX_GUESTS = 500;
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { global: 60, perVisitor: 8 };

export function guestDisplayName(): string {
  const adjectives = ["Sunny", "Curious", "Kind", "Calm", "Bright", "Happy", "Gentle", "Friendly"];
  const animals = ["Otter", "Panda", "Koala", "Robin", "Dolphin", "Owl", "Fox", "Penguin"];
  return `${adjectives[randomInt(adjectives.length)]} ${animals[randomInt(animals.length)]}`;
}

export function cleanGuestName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return name.length ? name : null;
}

// Shared PostgreSQL buckets so limits hold across serverless instances. The visitor key is a keyed hash, never a raw IP.
async function allowGuestCreation(visitor: string, now = new Date()): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.PRONTO_LOGIN_THROTTLE !== "1") return true;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Guest access requires server authentication configuration.");
  const start = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  const hashed = createHmac("sha256", secret).update(`guest:${visitor.slice(0, 200)}`).digest("hex");
  for (const [key, limit] of [["guest:global", LIMITS.global], [hashed, LIMITS.perVisitor]] as const) {
    const result = await query<{ attempts: number }>(`insert into auth_login_attempts(key,window_start,attempts)
      values($1,$2,1) on conflict(key,window_start) do update set attempts=auth_login_attempts.attempts+1 returning attempts`, [key, start]);
    if (result.rows[0].attempts > limit) return false;
  }
  return true;
}

// A guest is a demo-tenant business user with no password and every staff capability: this is a public, synthetic POC.
export async function createGuestReviewer(rawName: unknown, visitor: string): Promise<User> {
  const name = cleanGuestName(rawName);
  if (!name) throw new DemoError("Enter a name for your demo session.", 400);
  if (!await allowGuestCreation(visitor)) throw new DemoError("Too many new visitors right now. Please wait a few minutes and try again.", 429);
  const count = await query<{ n: number }>(
    `select count(*)::int n from users where client_id=$1 and email like $2`, [demoBusinessScope().clientId, `%@${GUEST_EMAIL_DOMAIN}`]);
  if (count.rows[0].n >= MAX_GUESTS) throw new DemoError("The demo has reached its visitor limit. Please ask the host for access.", 503);
  const user = await transaction(async (db) => {
    const created = await db.query<User>(
      `insert into users(client_id,email,name,role,password_hash) values($1,$2,$3,'client','!') returning *`,
      [demoBusinessScope().clientId, `guest-${randomUUID()}@${GUEST_EMAIL_DOMAIN}`, name]);
    await db.query(`insert into staff_permission_grants(client_id,user_id,permission,granted_by)
      select $1,$2,p,$2 from unnest($3::text[]) p`, [demoBusinessScope().clientId, created.rows[0].id, [...staffCapabilities]]);
    return created.rows[0];
  });
  await recordAuditLog({ clientId: demoBusinessScope().clientId, actorUserId: user.id, action: "auth.guest_reviewer_created",
    targetType: "user", targetId: user.id, metadata: { name } });
  return user;
}
