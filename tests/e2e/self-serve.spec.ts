import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { getPool } from "../../src/lib/db";
import { encodeSession } from "../../src/lib/session-token";
import { defaultHandovers } from "../../src/lib/self-serve/catalog";
import { verifyTestDatabase } from "../../scripts/test-db-safety";
test.skip(
  process.env.PRONTO_SELF_SERVE_ENABLED !== "1",
  "Self-serve fixture is opt-in.",
);
const client = randomUUID(),
  actor = randomUUID(),
  source = randomUUID();
test.beforeAll(async () => {
  await verifyTestDatabase();
  const db = getPool();
  await db.query(
    "insert into clients(id,name,slug,vertical,brand_voice) values($1,'Sora Bistro',$2,'fnb','Helpful')",
    [client, "ss-" + client],
  );
  await db.query(
    "insert into users(id,client_id,email,name,role,password_hash) values($1,$2,$3,'Owner','client','!')",
    [actor, client, actor + "@fixture.invalid"],
  );
  await db.query(
    "insert into staff_permission_grants(client_id,user_id,permission,granted_by) values($1,$2,'knowledge.approve',$2),($1,$2,'escalation.policy.manage',$2)",
    [client, actor],
  );
  await db.query(
    "insert into selfserve_settings(client_id,enabled,voice,handovers,alerts) values($1,true,$2,$3,$4)",
    [
      client,
      {
        mode: "custom",
        preset_id: "small",
        custom_notes: [
          "Use short, relaxed replies.",
          "Prefer lowercase greetings.",
          "Keep complaints calm and direct.",
        ],
        custom_origin: "existing",
      },
      defaultHandovers(),
      {
        whatsapp_enabled: false,
        email_enabled: false,
        whatsapp_number: "",
        email_address: "",
      },
    ],
  );
  await db.query(
    "insert into selfserve_sources(id,client_id,type,label,status) values($1,$2,'text','Menu & policies','ready')",
    [source, client],
  );
  await db.query(
    "insert into selfserve_rules(client_id,source_id,text,ref,topic,position,checked) values($1,$2,'Open daily from 10am to 10pm.','your text','opening_hours',0,true)",
    [client, source],
  );
  await mkdir("output/playwright/self-serve", { recursive: true });
});
test.afterAll(async () => {
  await getPool().query("delete from clients where id=$1", [client]);
  await getPool().end();
});
test("shared persisted state, editable voice, locked handovers, source errors and mobile layout", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await context.addCookies([
    {
      name: "pronto_session",
      value: encodeSession({
        userId: actor,
        role: "client",
        clientId: client,
        email: actor + "@fixture.invalid",
        name: "Owner",
        sv: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      url: "http://localhost:3000",
    },
  ]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/client/home");
  await expect(
    page.getByRole("heading", { name: "Hello, Sora Bistro" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your custom voice", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/home-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Brand voice", exact: true }).click();
  await page.getByRole("button", { name: /Playful/ }).click();
  await page.getByRole("button", { name: "Use Playful", exact: true }).click();
  await expect(page.getByText("Playful is your current voice")).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/voice-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByText("Playful is your current voice")).toBeVisible();
  await page
    .getByRole("link", { name: "Customise my brand voice", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Here’s what Pronto learned" }),
  ).toBeVisible();
  const note = page.getByRole("textbox", { name: "Style note 1" });
  await note.fill("Use concise, friendly wording.");
  await expect(page.getByText("Saved as your brand voice")).toHaveCount(0);
  await page.getByRole("button", { name: "Save my brand voice" }).click();
  await expect(page.getByText("Saved as your brand voice")).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/custom-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(
    page.getByText("Use concise, friendly wording.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Handovers", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Not covered by your rules" }),
  ).toBeDisabled();
  await page.getByRole("switch", { name: "Large group bookings" }).click();
  await expect(page.getByText("11+ people will hand over.")).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/handovers-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Business rules", exact: true }).click();
  await expect(page.getByText("1 rules live")).toBeVisible();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByRole("textbox", { name: "Source name" }).fill("Extra notes");
  await page
    .getByRole("textbox", { name: "Business information" })
    .fill("Corkage is S$30 per bottle.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Extra notes", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Source added. Pronto is extracting and checking its rules.",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/rules-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "output/playwright/self-serve/rules-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Brand voice", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Brand voice", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/self-serve/voice-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // Exceeds Next's default 10 MB proxy buffer without making a provider call.
  const large = await page.request.post("/api/self-serve/sources", {
    headers: { Origin: "http://localhost:3000" },
    multipart: {
      id: randomUUID(),
      type: "file",
      label: "Large transport fixture",
      file: {
        name: "large.txt",
        mimeType: "text/plain",
        buffer: Buffer.alloc(11 * 1024 * 1024, 65),
      },
    },
  });
  expect(large.status()).toBe(200);
  expect(browserErrors).toEqual([]);
});
