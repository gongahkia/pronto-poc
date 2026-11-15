import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {Pool} from 'pg';
import {verifyTestDatabase} from '../../scripts/test-db-safety';

const enabled = process.env.PRONTO_HUDDLE_E2E === '1' && process.env.PRONTO_HUDDLE_ACCESS === 'public-demo';
test.skip(!enabled,'Use pnpm test:huddle:browser:public with its owned disposable database.');
const origin = 'http://localhost:3000', workspace = '00000000-0000-4000-8000-00000000a101', environment = 'browser-fixture';
const query = '?'+new URLSearchParams({workspace,environment});
test.beforeAll(async () => {if(!enabled) return;if(process.env.PLAYWRIGHT_BASE_URL !== origin) throw new Error('Requires the task-owned loopback server.');await verifyTestDatabase();});
test.beforeEach(async ({context}) => {
  await context.route('**/*',route => {const url = new URL(route.request().url());return url.origin !== origin || url.pathname === '/api/demo/process' || url.pathname.includes('analytics') ? route.abort() : route.continue();});
});
async function choose(page:Page,name?:string) {
  await page.goto('/demo');expect((await page.context().cookies()).some(cookie => cookie.name === 'pronto_session')).toBe(false);
  if(name) await page.getByLabel('Your name').fill(name);
  await page.getByRole('button',{name:/Open business inbox/}).click();await expect(page.getByRole('heading',{name:'Inbox',exact:true})).toBeVisible();await expect(page.locator('[data-huddle-root]')).toHaveCount(1);
  const response = await page.request.get('/api/demo/feedback/v2/session'+query);expect(response.status()).toBe(200);const session = await response.json();expect(session.capabilities).toMatchObject({directory:false,mentions:false,assignment:false});return session.actor;
}
async function open(page:Page) {await page.getByRole('button',{name:'Expand feedback',exact:true}).click();await expect(page.locator('.content')).toHaveAttribute('aria-busy','false');if(await page.getByRole('button',{name:'Continue',exact:true}).count()){await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Continue',exact:true}).click();}await expect(page.getByRole('button',{name:'Add pinned comment',exact:true})).toBeVisible();}
async function exported(page:Page) {const response = await page.request.post('/api/demo/feedback/v2/exports',{headers:{origin},data:{scope:{workspace,environments:[environment]},format:'json'}});expect(response.status()).toBe(200);const data = await response.json();expect(data.complete).toBe(true);return data;}

test('a visitor with no account or entered name reads the migrated history and original attribution',async ({page}) => {
  const actor = await choose(page);expect(actor.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);await open(page);await page.locator('button.thread').filter({hasText:'Preserved historical reply'}).click();await expect(page.getByText('Preserved legacy page observation 🌍',{exact:true})).toBeVisible();await expect(page.getByText('Preserved historical reply',{exact:true})).toBeVisible();
  const data = await exported(page), thread = data.threads.find((item:{provenance?:{recordId:string}}) => item.provenance?.recordId === '00000000-0000-4000-8000-00000000f801');expect(thread).toMatchObject({createdAt:'2026-01-01T00:00:00.123456Z',updatedAt:'2026-01-02T00:00:00.987654Z'});expect(JSON.parse(thread.viewContext.legacy.thread.anchor_json)).toMatchObject({feedbackId:'preserved-legacy',opaque:{kept:true}});expect(data.comments.filter((item:{threadId:string}) => item.threadId === thread.id).map((item:{author:{name:string}}) => item.author.name)).toEqual(['Historical visitor','Historical visitor']);
  expect((await page.request.get('/api/demo/feedback/export?complete=1&status=all')).status()).toBe(200);expect((await page.request.get('/api/demo/feedback/v2/directory'+query)).status()).toBe(404);
});

test('distinct chooser visitors share pins, replies, status and complete export across a fresh session',async ({page,browser,browserName}) => {
  const second = await browser.newContext({baseURL:origin}), fresh = await browser.newContext({baseURL:origin}), note = `${browserName} public ${randomUUID()}`, reply = 'Visitor reply '+note;
  try {
    for(const context of [second,fresh]) await context.route('**/*',route => {const url = new URL(route.request().url());return url.origin !== origin || url.pathname === '/api/demo/process' || url.pathname.includes('analytics') ? route.abort() : route.continue();});
    const peer = await second.newPage(), a = await choose(page,'Public reviewer A'), b = await choose(peer,'Public reviewer B');expect(a.id).not.toBe(b.id);await open(page);await open(peer);
    await page.getByRole('button',{name:'Add pinned comment',exact:true}).click();await page.getByRole('heading',{name:'Inbox',exact:true}).click();await page.getByLabel('Your comment',{exact:true}).fill(note);await page.getByRole('radio',{name:'Blue',exact:true}).check();await page.getByRole('button',{name:'Post comment',exact:true}).click();await expect(page.getByText('Comment saved.',{exact:true})).toBeVisible();
    const colored = await exported(page);expect(colored.comments.find((item:{body:string})=>item.body===note).color).toBe('blue');const saved = colored.threads.find((item:{latestComment:{body:string}}) => item.latestComment.body === note), pin = page.locator('#huddle-pin-'+saved.id);
    await page.getByLabel('Reply',{exact:true}).fill('Draft survives collapsed review');await page.getByRole('button',{name:'Repin comment',exact:true}).click();await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByLabel('Reply',{exact:true})).toHaveValue('Draft survives collapsed review');await page.getByRole('button',{name:'Collapse feedback',exact:true}).click();await expect(page.locator('.panel')).toHaveCount(0);await expect(page.locator('[data-huddle-open][data-huddle-collapsed]')).toHaveCount(1);await pin.hover();await expect(page.getByRole('tooltip')).toContainText(note);
    await expect(peer.locator('button.thread').filter({hasText:note})).toBeVisible();await peer.locator('button.thread').filter({hasText:note}).click();await peer.getByLabel('Reply',{exact:true}).fill(reply);await peer.getByRole('button',{name:'Post reply',exact:true}).click();await page.bringToFront();await pin.focus();await expect(page.getByRole('tooltip')).toContainText(reply);await pin.click();await expect(page.getByLabel('Reply',{exact:true})).toHaveValue('Draft survives collapsed review');await expect(page.locator('.panel').getByText(reply,{exact:true})).toBeVisible();await page.getByRole('button',{name:'Resolve thread',exact:true}).click();await expect(page.getByRole('button',{name:'Reopen thread',exact:true})).toBeVisible();
    const data = await exported(peer), thread = data.threads.find((item:{latestComment:{body:string}}) => item.latestComment.body === reply);expect(thread.status).toBe('resolved');expect(data.comments.filter((item:{threadId:string}) => item.threadId === thread.id).map((item:{author:{id:string}}) => item.author.id)).toEqual([a.id,b.id]);
    const another = await fresh.newPage(), c = await choose(another);expect([a.id,b.id]).not.toContain(c.id);await open(another);await another.getByLabel('Show resolved',{exact:true}).check();await another.locator('button.thread').filter({hasText:reply}).click();await expect(another.getByText(note,{exact:true})).toBeVisible();await another.getByRole('button',{name:'Reopen thread',exact:true}).click();await expect(another.getByRole('button',{name:'Resolve thread',exact:true})).toBeVisible();
    await another.goto('/demo/customer');await expect(another.getByRole('button',{name:'Expand feedback',exact:true})).toBeVisible();
  } finally {await second.close();await fresh.close();}
});

test('public review retains session integrity, scope boundaries, CSRF and live revocation',async ({page}) => {
  expect((await page.request.get('/api/demo/feedback/v2/session'+query)).status()).toBe(401);const actor = await choose(page);await open(page);
  expect((await page.request.get('/api/demo/feedback/v2/session?workspace=other&environment='+environment)).status()).toBe(403);
  expect((await page.request.post('/api/demo/feedback/v2/threads'+query,{headers:{origin:'https://foreign.test'},data:{}})).status()).toBe(403);
  const db = new Pool({connectionString:process.env.PRONTO_TEST_DATABASE_URL});try {const row = (await db.query("select current_setting('pronto.fixture_nonce',true) nonce")).rows[0];if(!process.env.PRONTO_HUDDLE_FIXTURE_NONCE || row.nonce !== process.env.PRONTO_HUDDLE_FIXTURE_NONCE) throw new Error('Refusing to revoke outside the owned fixture.');await db.query('update users set session_version=session_version+1 where id=$1',[actor.id]);} finally {await db.end();}
  await expect(page.getByText(/^Review access is unavailable\./)).toBeVisible();await expect(page.locator('button.thread')).toHaveCount(0);await expect(page.locator('.pin')).toHaveCount(0);await expect(page.getByRole('button',{name:'Continue',exact:true})).toHaveCount(0);expect((await page.request.get('/api/demo/feedback/v2/threads'+query)).status()).toBe(401);
});


test('guest name editing keeps the same host identity and cannot edit another reviewer',async ({page})=>{
 const actor=await choose(page,'Before name');await page.getByRole('button',{name:'Expand feedback',exact:true}).click();await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();await page.getByLabel('Your name (optional)',{exact:true}).fill('After name');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('button',{name:'Add pinned comment',exact:true})).toBeVisible();
 const response=await page.request.get('/api/demo/feedback/v2/session'+query);expect((await response.json()).actor).toMatchObject({id:actor.id,name:'After name'});
 expect((await page.request.post('/api/demo/feedback/profile',{headers:{origin},data:{name:'Imposter',userId:workspace}})).status()).toBe(400);expect((await page.request.post('/api/demo/feedback/profile',{headers:{origin:'https://foreign.test'},data:{name:'Imposter'}})).status()).toBe(403);
});
