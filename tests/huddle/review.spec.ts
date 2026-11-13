import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { verifyTestDatabase } from '../../scripts/test-db-safety';

const enabled = process.env.PRONTO_HUDDLE_E2E === '1';
test.skip(!enabled, 'Requires explicitly prepared disposable Pronto and Huddle fixtures.');
const pronto = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
const huddle = process.env.HUDDLE_TEST_SERVER_URL ?? 'http://127.0.0.1:4317';
const project = '11111111-1111-4111-8111-111111111111';
test.beforeAll(async () => {
  if (!enabled) return;
  for (const origin of [pronto, huddle]) {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.port || url.port === '4310') throw new Error('Use explicit loopback fixture services, separate from the ordinary Huddle installation.');
  }
  await verifyTestDatabase();
});
async function signIn(page: Page, member = false) {
  await page.goto(huddle);
  await page.getByLabel('Email', { exact: true }).fill(member ? 'member@huddle.test' : 'admin@huddle.test');
  await page.getByLabel('Password', { exact: true }).fill(member ? 'huddle-member-password' : 'huddle-browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Feedback inbox', exact: true })).toBeVisible();
  const login = await page.request.post(`${pronto}/api/auth/login`, { headers: { origin: pronto },
    form: { email: 'responder@ps-cafe-demo.test', password: 'pronto-ps-demo' }, maxRedirects: 0 });
  expect(login.status()).toBe(303);
  const response = await page.goto(`${pronto}/client/inbox?private-filter=omit-me#private-fragment`);
  expect(response!.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  expect(response!.headers()['content-security-policy']).toContain(`connect-src 'self' https: ${huddle}`);
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.locator('[data-huddle-root]')).toHaveCount(1);
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Huddle feedback', exact: true }).click();
  const pending = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Huddle', exact: true }).click();
  const popup = await pending;
  await popup.getByRole('button', { name: 'Allow review access', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pin a comment', exact: true })).toBeVisible();
}

test('Pronto reviewers share pins/replies, navigate, export and retain earlier feedback on mobile', async ({ browser, browserName }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const errors: string[] = [];
  const note = `Pronto ${browserName} review ${Date.now()}`, reply = `Designer follow-up ${Date.now()}`;
  try {
    for (const context of [a, b]) {
      await context.route('**/*', route => [pronto, huddle].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    }
    const p = await a.newPage(), q = await b.newPage();
    await p.goto(`${pronto}/client/inbox`);
    await expect(p.locator('[data-huddle-root]')).toHaveCount(0);
    await signIn(p); await signIn(q, true); await connect(p); await connect(q);
    await p.getByRole('button', { name: 'Pin a comment', exact: true }).click();
    await expect(p.locator('[data-huddle-open]')).toHaveCount(1);
    await p.getByRole('heading', { name: 'Inbox', exact: true }).click();
    await p.getByLabel('Your comment', { exact: true }).fill(note);
    await p.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(p.getByText('Comment saved.', { exact: true })).toBeVisible();
    await expect(q.getByText(note, { exact: true })).toBeVisible();
    await q.getByRole('button').filter({ hasText: note }).click();
    await q.getByLabel('Reply', { exact: true }).fill(reply);
    await q.getByRole('button', { name: 'Post reply', exact: true }).click();
    await expect(p.getByText(reply, { exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Resolve thread', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Reopen thread', exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Reopen thread', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();

    const exported = await p.request.get(`${huddle}/api/projects/${project}/export`);
    expect(exported.ok()).toBe(true);
    const data = await exported.json();
    const thread = data.threads.find((t: { comments: { body: string }[] }) => t.comments.some(c => c.body === note));
    expect(thread.page).toBe('/client/inbox'); expect(thread.pageUrl).toBe(`${pronto}/client/inbox`);
    expect(thread.comments.map((c: { body: string }) => c.body)).toEqual([note, reply]);
    expect(thread.release).toBe('pronto-dogfood-fixture');

    const mounted = await p.locator('[data-huddle-root]').elementHandle();
    const refreshed = p.waitForResponse(response => new URL(response.url()).pathname === '/client/inbox' && response.request().headers().rsc === '1');
    await p.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(p.locator('[data-huddle-open]')).toHaveCount(0);
    await refreshed;
    expect(await mounted!.evaluate(root => root.isConnected)).toBe(true);
    await p.getByRole('button', { name: 'Huddle feedback', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Connect Huddle', exact: true })).toHaveCount(0);
    await p.getByRole('button', { name: 'Close', exact: true }).click();
    await p.getByRole('link', { name: 'Business Knowledge', exact: true }).first().click();
    await expect(p.getByRole('heading', { name: 'Business Knowledge', exact: true })).toBeVisible();
    await expect(p.locator('[data-huddle-root]')).toHaveCount(1);
    await p.goBack(); await expect(p.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(p.locator('[data-huddle-root]')).toHaveCount(1);

    const legacy = `Earlier Pronto note ${Date.now()}`;
    expect((await p.request.post(`${pronto}/api/demo/feedback`, { headers: { origin: pronto }, data: {
      action: 'create', requestId: randomUUID(), path: '/demo/customer',
      anchor: { selector: 'main', label: 'Customer demo', quote: '', x: 0.5, y: 0.5 }, body: legacy,
    } })).ok()).toBe(true);
    await p.setViewportSize({ width: 390, height: 844 }); await p.goto(`${pronto}/demo/customer`);
    await expect(p.getByRole('button', { name: 'Huddle feedback', exact: true })).toBeVisible();
    expect(await p.locator('[data-huddle-root]').evaluate(root => root.shadowRoot!.querySelector('.launcher') === null)).toBe(true);
    const trigger = await p.getByRole('button', { name: 'Huddle feedback', exact: true }).boundingBox();
    const send = await p.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
    expect(trigger!.y + trigger!.height).toBeLessThan(send!.y);
    await p.getByRole('button', { name: 'Earlier feedback', exact: true }).click();
    await expect(p.locator('[data-huddle-root]')).toHaveCount(0);
    await p.getByRole('button', { name: 'Open prototype feedback', exact: true }).click();
    await expect(p.getByText(legacy, { exact: true })).toBeVisible();
    await expect(p.getByRole('link', { name: 'Export workspace feedback', exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Close feedback', exact: true }).click();
    await p.getByRole('button', { name: 'Use Huddle', exact: true }).click();
    await expect(p.locator('[data-huddle-root]')).toHaveCount(1);
    await p.goto(`${pronto}/status`); await expect(p.locator('[data-huddle-root]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await a.close(); await b.close(); }
});

test('a failed Huddle connection leaves Pronto navigation and earlier feedback usable', async ({ page }) => {
  await signIn(page);
  await page.route(`${huddle}/api/auth/exchange`, route => route.abort('failed'));
  await page.getByRole('button', { name: 'Huddle feedback', exact: true }).click();
  const pending = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Huddle', exact: true }).click();
  const popup = await pending;
  await popup.getByRole('button', { name: 'Allow review access', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Huddle feedback', exact: true }).getByRole('alert')).toContainText('Could not reach Huddle');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Earlier feedback', exact: true }).click();
  await page.getByRole('button', { name: 'Open prototype feedback', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Export workspace feedback', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close feedback', exact: true }).click();
  await page.getByRole('link', { name: 'Business Knowledge', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Business Knowledge', exact: true })).toBeVisible();
});
