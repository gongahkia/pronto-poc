import { test, expect, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { getPool } from "../../src/lib/db";
import { hashPassword } from "../../src/lib/password";
import { verifyTestDatabase } from "../../scripts/test-db-safety";
import { setupPsCafeDemo } from "../../scripts/demo/ps-cafe-raffles-city";

test.beforeAll(async () => { await verifyTestDatabase(); await setupPsCafeDemo(); });
test.beforeEach(async ({ page }) => {
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000").origin;
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});
async function login(page: Page, email: string, password: string) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // /client redirects again according to the account's business permissions.
  await page.waitForURL(/\/(?:account|client\/(?:inbox|knowledge))$/, { waitUntil: "load" });
}

test("operator sees account switching, cannot mutate business state, and can explicitly switch", async ({ page }) => {
  await login(page, "operator@pronto.sg", "pronto-operator");
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/client/inbox");
  await expect(page.getByRole("heading", { name: "Business inbox access" })).toBeVisible();
  await expect(page.getByText(/does not grant business-owner access/)).toBeVisible();
  const denied = await page.request.post(`/api/client/conversations/${randomUUID()}`, {
    headers: { origin: new URL(page.url()).origin }, data: { action: "takeover" },
  });
  expect(denied.status()).toBe(403);
  await page.getByRole("button", { name: "Sign out and switch account" }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email", { exact: true }).fill("responder@ps-cafe-demo.test");
  await page.getByLabel("Password", { exact: true }).fill("pronto-ps-demo");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/client\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
});

test("staff without conversation permission sees an explanation", async ({ page }) => {
  await login(page, "staff@ps-cafe-demo.test", "pronto-ps-demo"); await page.goto("/client/inbox");
  await expect(page.getByText(/does not have permission to review/)).toBeVisible();
  await expect(page.getByTestId("workspace-loading")).toHaveCount(0);
});

test("an authorized responder cannot read or take over another business conversation", async ({ page }) => {
  const clientId = randomUUID(), channelId = randomUUID(), conversationId = randomUUID();
  await getPool().query("insert into clients(id,name,slug,vertical,brand_voice) values($1,'Foreign synthetic business',$2,'test','Synthetic test voice')", [clientId, clientId]);
  try {
    await getPool().query("insert into channels(id,client_id,kind,name,status) values($1,$2,'console','Foreign synthetic channel','active')", [channelId, clientId]);
    await getPool().query("insert into conversations(id,client_id,channel_id,external_thread_id) values($1,$2,$3,$4)", [conversationId, clientId, channelId, conversationId]);
    await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
    await page.goto(`/client/conversations/${conversationId}`);
    await expect(page.getByRole("heading", { name: "This Pronto view is unavailable." })).toBeVisible();
    expect((await page.request.post(`/api/client/conversations/${conversationId}`, {
      headers: { origin: new URL(page.url()).origin }, form: { action: "takeover" },
    })).status()).toBe(404);
  } finally { await getPool().query("delete from clients where id=$1", [clientId]); }
});

test("missing business membership has a clear access state", async ({ page }) => {
  const id = randomUUID(), email = `unassigned-${id}@example.test`;
  await getPool().query("insert into users(id,email,name,role,password_hash) values($1,$2,'Unassigned test','client',$3)",
    [id, email, await hashPassword("synthetic-unassigned-password")]);
  try {
    const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const response = await page.request.post("/api/auth/login", { headers: { origin }, form: { email, password: "synthetic-unassigned-password" }, maxRedirects: 0 });
    expect(response.status()).toBe(303); await page.goto("/client/inbox");
    await expect(page.getByText(/has no business membership/)).toBeVisible();
  } finally { await getPool().query("delete from users where id=$1", [id]); }
});

test("expired sessions and shared-tab sign-out reach sign-in", async ({ page }) => {
  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  const second = await page.context().newPage(); await second.goto("/client/inbox");
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === "pronto_session")!;
  const payload = JSON.parse(Buffer.from(cookie.value.split(".")[0], "base64url").toString());
  payload.exp = 1; const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("base64url");
  await page.context().addCookies([{ ...cookie, value: `${body}.${signature}` }]);
  await second.reload(); await expect(second.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect((await page.request.get("/api/demo/customer")).status()).toBe(401);
  await page.context().clearCookies(); await page.goto("/client/inbox");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await second.close();
});

test("slow database reads expose recovery guidance and then render real inbox content", async ({ page }) => {
  test.setTimeout(45_000); await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  await page.goto("/client/inbox"); await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  const lock = await getPool().connect();
  try {
    await lock.query("begin"); await lock.query("set local idle_in_transaction_session_timeout = '60s'"); await lock.query("lock table conversations in access exclusive mode");
    await page.goto("/client/inbox", { waitUntil: "commit" });
    await expect(page.getByText(/taking longer than expected/)).toBeVisible({ timeout: 18_000 });
    await expect(page.getByRole("link", { name: "Reload business inbox" })).toBeVisible();
    // Hold a genuine database read behind the fixture lock beyond ten seconds.
    // The initial streamed fallback must offer recovery before React hydrates.
    await lock.query("select pg_sleep(11)");
    await expect(page.getByRole("heading", { name: "Loading your workspace…" })).toBeVisible();
    await lock.query("rollback");
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-loading")).toHaveCount(0);
  } finally { await lock.query("rollback").catch(() => {}); lock.release(); }
});

test("a database statement timeout reaches a visible error and read-only retry recovers", async ({ page }) => {
  test.setTimeout(65_000); await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  await page.goto("/client/inbox"); await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  const lock = await getPool().connect();
  try {
    await lock.query("begin"); await lock.query("set local idle_in_transaction_session_timeout = '60s'"); await lock.query("lock table conversations in access exclusive mode");
    await page.goto("/client/inbox", { waitUntil: "commit" });
    await expect(page.getByRole("heading", { name: "The business workspace could not load." })).toBeVisible({ timeout: 40_000 });
    await lock.query("rollback");
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible({ timeout: 15_000 });
  } finally { await lock.query("rollback").catch(() => {}); lock.release(); }
});

test("failed client navigation recovers through a full page request", async ({ page }) => {
  test.skip(process.env.PRONTO_CUSTOMER_DEMO_ENABLED !== "1", "Requires local simulator.");
  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo"); await page.goto("/demo/customer");
  await page.route("**/client/inbox?*", route => route.abort("failed"));
  await page.getByRole("link", { name: "Open business inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible({ timeout: 15_000 });
  await page.reload(); await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
});
