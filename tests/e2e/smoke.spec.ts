import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getPool } from "../../src/lib/db";
import { PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_EMAIL_ID,
  setupPsCafeDemo } from "../../scripts/demo/ps-cafe-raffles-city";

const operatorLogin = {
  email: "operator@pronto.sg",
  password: "pronto-operator",
};

const clientLogin = {
  email: "owner@northbridgenasi.sg",
  password: "pronto-client",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" && url.port === "3000") {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
});

test("login page renders", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Customer service grounded in your business." })).toBeVisible();
  await expect(page.getByText("Human handoff when a question needs care")).toBeVisible();
  await expect(page.getByText("pronto-operator")).toHaveCount(0);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("protected pages redirect and protected APIs reject anonymous access", async ({
  page,
  request,
}) => {
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/login$/);

  const response = await request.get("/api/client/settings");
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Unauthenticated." });
});

test("seeded operator lands on account details and can inspect the protected portfolio", async ({ page }) => {
  await login(page, operatorLogin.email, operatorLogin.password);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your Pronto account" })).toBeVisible();
  const response = await page.request.get("/api/operator/inspect?view=clients");
  expect(response.status()).toBe(200);
  expect((await response.json()).clients.some((client: { name: string }) => client.name === "North Bridge Nasi")).toBe(true);
});

test("operator inspection exposes channel state without provider credentials", async ({ page }) => {
  await login(page, operatorLogin.email, operatorLogin.password);
  await expect(page).toHaveURL(/\/account$/);
  const portfolio = await (await page.request.get("/api/operator/inspect?view=clients")).json();
  const client = portfolio.clients.find((client: { name: string }) => client.name === "North Bridge Nasi");
  const response = await page.request.get(`/api/operator/inspect?view=client&clientId=${client.id}`);
  expect(response.status()).toBe(200);
  const details = await response.json();
  expect(details.channels.length).toBeGreaterThan(0);
  expect(details.channels.every((channel: Record<string, unknown>) => !("credentials" in channel))).toBe(true);
});

test("an authorized PS.Cafe responder can render the inbox", async ({ page }) => {
  await setupPsCafeDemo();
  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");

  await expect(page).toHaveURL(/\/client\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needs attention",exact:true })).toBeVisible();
  for (const label of ["Inbox", "Business Knowledge", "Insights"])
    await expect(page.getByRole("navigation").getByRole("link", { name: label }).first()).toBeVisible();
});

test("client account cannot inspect operator diagnostics and the retired UI is unavailable", async ({ page }) => {
  await login(page, clientLogin.email, clientLogin.password);
  expect((await page.request.get("/api/operator/inspect?view=operations")).status()).toBe(403);
  await page.goto("/operator/operations");
  await expect(page.getByRole("heading", { name: "This Pronto view is unavailable." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations", exact: true })).toHaveCount(0);
});

test("retired assistant entry opens knowledge without a private preview", async ({ page }) => {
  await login(page, clientLogin.email, clientLogin.password);
  await page.goto("/client/assistant");
  await expect(page).toHaveURL(/\/client\/knowledge$/);
  await expect(page.getByRole("heading", { name: "Test & publish" })).toHaveCount(0);
  expect((await page.request.post("/api/client/assistant-test")).status()).toBe(404);
  await expect(page.getByRole("navigation", { name: "Assistant setup" })).toHaveCount(0);
  for (const name of ["Knowledge", "Brand voice", "Handoff rules"])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  for (const [name, path] of [["Brand voice", "brand-voice"], ["Handoff rules", "handoff-rules"]]) {
    const card = page.getByRole("link", { name: `View ${name.toLowerCase()} details`, exact: true });
    await expect(card.locator("summary, form, input, select, textarea")).toHaveCount(0);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/client/knowledge/${path}$`));
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to business knowledge", exact: true }).click();
    await expect(page).toHaveURL(/\/client\/knowledge$/);
  }
});

test("login and dashboards avoid obvious mobile horizontal overflow", async ({ page }) => {
  await setupPsCafeDemo();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/login");
  await expectNoHorizontalOverflow(page);

  await login(page, operatorLogin.email, operatorLogin.password);
  await expect(page.getByRole("heading", { name: "Your Pronto account" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("the five retired operator destinations no longer render a dashboard", async ({ page }) => {
  await login(page, operatorLogin.email, operatorLogin.password);
  for (const route of ["/operator", "/operator/overview", "/operator/conversations", "/operator/knowledge-connections", "/operator/operations"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: "This Pronto view is unavailable." })).toBeVisible();
    await expect(page.getByText("Pronto HQ", { exact: true })).toHaveCount(0);
  }
});

test("operator account details remain usable on mobile without retired UI links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, operatorLogin.email, operatorLogin.password);
  await expect(page.getByRole("heading", { name: "Your Pronto account" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('a[href^="/operator"]')).toHaveCount(0);
  const inbox = page.getByRole("link", { name: "Open business inbox" });
  await inbox.focus(); await expect(inbox).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Business inbox access" })).toBeVisible();
});

test("business destinations remain usable by keyboard on mobile", async ({ page }) => {
  await setupPsCafeDemo();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  for (const [route, heading] of [
    ["/client/inbox", "Inbox"], ["/client/activity", "Inbox"],
    ["/client/knowledge", "Business Knowledge"],
  ]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await skip.focus();
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
  }
});

test("removed business pages and their navigation links are unavailable", async ({ page }) => {
  await login(page, clientLogin.email, clientLogin.password);
  await expect(page.locator('a[href="/client/channels"],a[href="/client/contact-pronto"],a[href="/client/settings"]')).toHaveCount(0);
  for (const path of ["/client/channels", "/client/contact-pronto", "/client/settings"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  }
});

test("PS.Cafe synthetic staff proposes and reviews knowledge", async ({ page }) => {
  await setupPsCafeDemo();
  const suggestionTitle = `Dietary caveat demo ${Date.now()}`;
  await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
  await expect(page).toHaveURL(/\/client\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.goto("/client/knowledge");
  await expect(page.getByRole("heading", { name: "Business Knowledge" })).toBeVisible();
  await page.getByRole("button", { name: "Suggest a correction", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(suggestionTitle);
  await page.getByRole("textbox", { name: "Proposed answer or policy" }).fill("Ask staff to confirm ingredients before making a dietary promise.");
  await page.getByRole("textbox", { name: "Why should this change?" }).fill("Ingredients can change.");
  await page.getByRole("button", { name: "Submit correction", exact: true }).click();
  await expect(page.getByText("Saved for review. Customer answers have not changed.")).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, "approver@ps-cafe-demo.test", "pronto-ps-demo");
  await page.goto("/client/knowledge");
  await expect(page.getByText(suggestionTitle)).toBeVisible();
  await page.getByRole("link").filter({ hasText: suggestionTitle }).click();
  await page.getByRole("textbox", { name: "Review note", exact: true }).fill("Synthetic business review only");
  await page.getByRole("button", { name: "Approve revision", exact: true }).click();
  await expect(page.getByText(suggestionTitle)).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

});

test("PS.Cafe staff submits a text source; only a delegated reviewer can approve its exact revision", async ({ page }) => {
  await setupPsCafeDemo();
  const title = `Synthetic source ${randomUUID()}`;
  await login(page, "staff@ps-cafe-demo.test", "pronto-ps-demo");
  await page.goto("/client/knowledge");
  await page.getByRole("button", { name: "Add information", exact: true }).click();
  await page.getByRole("textbox", { name: "Source title" }).fill(title);
  await page.getByRole("button", { name: "Paste content", exact: true }).click();
  await page.getByRole("textbox", { name: "Source content" }).fill("Synthetic test policy says to ask a person for special requests.");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText("Pending review", { exact: true }).last()).toBeVisible();
  const pending = await getPool().query<{ id: string; target_source_id: string }>(
    "select id,target_source_id from knowledge_source_submissions where client_id = $1 and status = 'pending' and id in (select submission_id from knowledge_source_submission_revisions where title = $2)",
    [PS_CAFE_DEMO_CLIENT_ID, title]);
  expect(pending.rows).toHaveLength(1);
  expect((await getPool().query("select count(*)::int as n from knowledge_sources where id = $1", [pending.rows[0].target_source_id])).rows[0].n).toBe(0);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, "approver@ps-cafe-demo.test", "pronto-ps-demo");
  await page.goto("/client/knowledge");
  await page.getByRole("link").filter({ hasText: title }).click();
  await page.getByRole("textbox", { name: "Review note", exact: true }).fill("Synthetic source reviewed");
  await page.getByRole("button", { name: "Approve revision", exact: true }).click();
  await expect.poll(async () => (await getPool().query("select status,reviewed_revision from knowledge_source_submissions where id = $1", [pending.rows[0].id])).rows[0], { timeout: 10_000 })
    .toMatchObject({ status: "approved", reviewed_revision: 1 });
  expect((await getPool().query("select count(*)::int as n from knowledge_sources where id = $1", [pending.rows[0].target_source_id])).rows[0].n).toBe(0);
});

test("PS.Cafe responder claims, replies and explicitly releases a local email handoff", async ({ page }) => {
  test.skip(process.env.PRONTO_TEST_LOCAL_MAIL !== "1", "Requires opt-in loopback Mailpit transport.");
  test.setTimeout(60_000);
  await setupPsCafeDemo();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const inserted = await getPool().query<{ id: string }>(
    `with conversation as (
       insert into conversations (id, client_id, channel_id, external_thread_id, customer_handle, status)
       values ($1, $2, $3, $4, $4, 'escalated') returning id
     ), message as (
       insert into messages (id, client_id, channel_id, conversation_id, external_message_id, sender_role, body)
       values ($5, $2, $3, $1, $6, 'customer', 'Please help with my special request') returning id
     )
     insert into escalations (client_id, conversation_id, message_id, reason_code, reason_detail)
     values ($2, $1, $5, 'other', 'Synthetic local handoff') returning id`,
    [conversationId, PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_EMAIL_ID,
      `local-${conversationId}@example.test`, messageId, `local-${messageId}`]);
  const escalationId = inserted.rows[0].id;
  try {
    await login(page, "staff@ps-cafe-demo.test", "pronto-ps-demo");
    await page.goto(`/client/conversations/${conversationId}`);
    await expect(page.getByRole("heading", { name: "Business inbox access" })).toBeVisible();
    await page.goto("/client");
    await page.getByRole("button", { name: "Log out" }).click();
    await login(page, clientLogin.email, clientLogin.password);
    await page.goto(`/client/conversations/${conversationId}`);
    await expect(page.getByRole("heading", { name: "Business inbox access" })).toBeVisible();
    await page.goto("/client");
    await page.getByRole("button", { name: "Log out" }).click();
    await login(page, "responder@ps-cafe-demo.test", "pronto-ps-demo");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await page.locator(`a[href="/client/conversations/${conversationId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/client/conversations/${conversationId}`));
    await page.getByRole("button", { name: "Take over", exact: true }).click();
    await expect(page.getByText("claimed", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Write the reply the customer will receive").fill("We can help with this request.");
    await page.getByRole("button", { name: "Send reply and resolve" }).click();
    await expect(page.getByRole("button", { name: "Release conversation to AI" })).toBeVisible();
    const outbound = await getPool().query<{ status: string }>(
      "select status from outbound_messages where client_id = $1 and escalation_id = $2",
      [PS_CAFE_DEMO_CLIENT_ID, escalationId]);
    expect(outbound.rows[0]?.status).toBe("sent");
    const captured = await fetch("http://127.0.0.1:8025/api/v1/messages");
    expect(captured.ok).toBe(true);
    const mailbox = await captured.json() as { messages: Array<{ To: Array<{ Address: string }> }> };
    expect(mailbox.messages.some((message) => message.To.some((recipient) =>
      recipient.Address === `local-${conversationId}@example.test`))).toBe(true);
    await page.getByRole("button", { name: "Release conversation to AI" }).click();
    const state = await getPool().query<{ status: string }>(
      "select status from conversations where id = $1 and client_id = $2", [conversationId, PS_CAFE_DEMO_CLIENT_ID]);
    expect(state.rows[0].status).toBe("active");
  } finally {
    await getPool().query("delete from conversations where id = $1 and client_id = $2",
      [conversationId, PS_CAFE_DEMO_CLIENT_ID]);
  }
});

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(?:account|client\/(?:inbox|knowledge))$/, { waitUntil: "load" });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(16);
}
