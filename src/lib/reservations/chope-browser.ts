import { assertTurnActive, currentTurnSignal } from "@/lib/agent/turn-budget";
import type { AvailabilityResult, ReservationAvailabilityRequest, ReservationConnector, ReservationResult } from "@/lib/reservations/types";
import { approvedChopeBookingLink, validateAvailabilityRequest } from "@/lib/reservations/chope";
import { logInfo, logWarn } from "@/lib/logger";

const GET_TIMES_PATH = "/singapore-restaurants/categories/get_times";
const MIN_READ_INTERVAL_MS = 60_000;
let nextReadAt = 0;

export type ChopeBrowserConfig = {
  clientId: string;
  outletId: string;
  listingUrl: string;
  authorizedAt: string;
  scope: "demo_availability";
};

const unsupported: ReservationResult = { status: "unsupported",
  reason: "Chope booking writes are not enabled." };

export function chopeDateMatches(raw: string | null, expectedDate: string): boolean {
  const match = /^(\d{1,2})-(\d{1,2})-(20\d{2})$/.exec(raw ?? "");
  return !!match && `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` === expectedDate;
}

export function validChopeBrowserConfig(config: ChopeBrowserConfig): boolean {
  if (!config.clientId || !/^[a-z0-9-]{4,80}$/i.test(config.outletId) ||
      config.scope !== "demo_availability" || !Number.isFinite(Date.parse(config.authorizedAt))) return false;
  try {
    const url = new URL(config.listingUrl);
    return url.protocol === "https:" && url.hostname === "www.chope.co" && !url.port && !url.username &&
      !url.password && !url.search && !url.hash &&
      /^\/singapore-restaurants\/restaurant\/[a-z0-9-]+\/?$/i.test(url.pathname);
  } catch { return false; }
}

export function configuredChopeBrowserConnector(clientId: string,
  profile: Record<string, unknown>): ReservationConnector | null {
  if (process.env.PRONTO_CHOPE_LIVE_READS !== "1" ||
      process.env.CHOPE_LIVE_READ_APPROVED !== "1") return null;
  const value = profile.chopeAvailability;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const setting = value as Record<string, unknown>;
  if (setting.enabled !== true || setting.mode !== "browser" ||
      setting.scope !== "demo_availability" || typeof setting.outletId !== "string" ||
      typeof setting.listingUrl !== "string" || typeof setting.authorizedAt !== "string") return null;
  const link = approvedChopeBookingLink(profile);
  if (!link || link.outletId !== setting.outletId || link.url !== setting.listingUrl) return null;
  const config: ChopeBrowserConfig = { clientId, outletId: setting.outletId,
    listingUrl: setting.listingUrl, authorizedAt: setting.authorizedAt,
    scope: "demo_availability" };
  return validChopeBrowserConfig(config) ? createChopeBrowserConnector(config) : null;
}

export function createChopeBrowserConnector(config: ChopeBrowserConfig,
  read: (request: ReservationAvailabilityRequest, config: ChopeBrowserConfig) => Promise<AvailabilityResult> =
    readChopeBrowserAvailability): ReservationConnector {
  if (!validChopeBrowserConfig(config)) throw new Error("Invalid Chope browser authorization configuration.");
  return {
    provider: "chope",
    capabilities: { availability: true, create: false, read: false, update: false, cancel: false,
      listingPreselection: "experimental_chope_listing_v1" },
    async getAvailability(request) {
      if (request.clientId !== config.clientId || request.outletId !== config.outletId) {
        return errorResult(request, "missing_authorization");
      }
      if (!validateAvailabilityRequest(request)) return errorResult(request, "invalid_request");
      return read(request, config);
    },
    async createReservation() { return unsupported; },
    async getReservation() { return unsupported; },
    async updateReservation() { return unsupported; },
    async cancelReservation() { return unsupported; },
  };
}

function errorResult(request: ReservationAvailabilityRequest, code: NonNullable<AvailabilityResult["errorCode"]>):
  AvailabilityResult {
  return { outletId: request.outletId, date: request.date, partySize: request.partySize,
    availableSlots: [], timezone: "Asia/Singapore", provider: "chope", observedAt: null,
    status: "error", errorCode: code };
}

export function parseChopeTimeOptions(options: { value: string; text: string; disabled: boolean }[]):
  { status: "available" | "unavailable" | "error"; slots: string[] } {
  if (!options.length) return { status: "error", slots: [] };
  const slots = new Set<string>();
  let unavailable = false;
  for (const option of options) {
    if (/^not available$/i.test(option.text.trim()) || /^not available$/i.test(option.value.trim())) {
      unavailable = true;
      continue;
    }
    if (option.disabled || /^(select|choose)\b/i.test(option.text.trim())) continue;
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(option.value.trim()) ??
      /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(option.text.trim());
    if (!match) return { status: "error", slots: [] };
    const rawHour = Number(match[1]);
    const minute = Number(match[2]);
    if (rawHour < 1 || rawHour > 12 || minute > 59) return { status: "error", slots: [] };
    const hour = rawHour % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
    slots.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  // A contradictory provider fragment is unknown, never evidence of a slot.
  if (slots.size && unavailable) return { status: "error", slots: [] };
  if (slots.size) return { status: "available", slots: [...slots].sort() };
  return unavailable ? { status: "unavailable", slots: [] } : { status: "error", slots: [] };
}

export async function readChopeBrowserAvailability(request: ReservationAvailabilityRequest,
  config: ChopeBrowserConfig): Promise<AvailabilityResult> {
  if (process.env.PRONTO_CHOPE_LIVE_READS !== "1" ||
      process.env.CHOPE_LIVE_READ_APPROVED !== "1") return errorResult(request, "missing_authorization");
  if (!validChopeBrowserConfig(config) || request.clientId !== config.clientId ||
      request.outletId !== config.outletId) return errorResult(request, "missing_authorization");
  if (!validateAvailabilityRequest(request)) return errorResult(request, "invalid_request");
  const now = Date.now();
  if (now < nextReadAt) return errorResult(request, "rate_limited");
  nextReadAt = now + MIN_READ_INTERVAL_MS;

  let browser: Awaited<ReturnType<(typeof import("playwright-core"))["chromium"]["launch"]>> | null = null;
  const turnSignal = currentTurnSignal();
  const abortRead = () => { void browser?.close(); };
  turnSignal?.addEventListener("abort", abortRead, { once: true });
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    assertTurnActive();
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, timeout: 10_000,
      executablePath: process.env.PRONTO_CHOPE_CHROMIUM_PATH || undefined });
    assertTurnActive();
    const context = await browser.newContext({ timezoneId: "Asia/Singapore", locale: "en-SG",
      serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    timeout = setTimeout(() => { timedOut = true; void browser?.close(); }, 20_000);
    let allowedRead = false;
    await context.route("**/*", async (route) => {
      const call = route.request();
      const url = new URL(call.url());
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { await route.abort(); return; }
      const hostAllowed = url.hostname === "chope.co" || url.hostname.endsWith(".chope.co");
      if (hostAllowed && url.protocol === "https:" && !url.port && !url.username && !url.password &&
          !/^(?:book|booking)(?:v\d+)?\./i.test(url.hostname) && call.method() === "GET" &&
          !/\/booking|\/payment|\/checkout/i.test(pathname)) {
        await route.continue();
        return;
      }
      if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
          !url.search && url.hostname === "www.chope.co" && url.pathname === GET_TIMES_PATH &&
          call.method() === "POST" && !allowedRead) {
        const fields = new URLSearchParams(call.postData() ?? "");
        if (["rid", "date", "adults", "children"].every((key) => fields.getAll(key).length === 1) &&
            fields.get("rid") === request.outletId && chopeDateMatches(fields.get("date"), request.date) &&
            fields.get("adults") === String(request.partySize) && fields.get("children") === "0") {
          allowedRead = true;
          await route.continue();
          return;
        }
      }
      await route.abort();
    });
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      const fields = new URLSearchParams(response.request().postData() ?? "");
      return url.hostname === "www.chope.co" && url.pathname === GET_TIMES_PATH &&
        response.request().method() === "POST" && fields.get("rid") === request.outletId &&
        chopeDateMatches(fields.get("date"), request.date) && fields.get("adults") === String(request.partySize);
    }, { timeout: 15_000 }).catch(() => null);
    const listing = await page.goto(config.listingUrl, { waitUntil: "domcontentloaded", timeout: 12_000 });
    if (listing?.status() === 429) return errorResult(request, "rate_limited");
    if (!listing?.ok()) return errorResult(request, "network_error");
    if (await page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"]').count()) {
      return errorResult(request, "unexpected_response");
    }
    const pageOutletId = await page.locator("#rid").inputValue().catch(() => "");
    if (pageOutletId !== request.outletId) return errorResult(request, "missing_authorization");
    const todayInSingapore = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    // Default today/2 selections may not start a read until the form changes.
    // Preserve an already-started matching read instead of issuing a duplicate.
    if (request.partySize !== 2 || request.date !== todayInSingapore || !allowedRead) {
      await page.locator("#diners-field").click();
      await page.locator("#adults").selectOption(String(request.partySize));
    }
    if (request.date !== todayInSingapore) {
      // Chope's party picker remains over the date field after selecting adults.
      // Trigger the same date-field handler without submitting the booking form.
      await page.locator("#date-field").dispatchEvent("click");
      const [year, month, day] = request.date.split("-").map(Number);
      const daySelector = `#calendar-box td[year="${year}"][month="${month}"][day="${day}"]`;
      for (let index = 0; index < 3 && await page.locator(daySelector).count() === 0; index += 1) {
        await page.locator("#calendar-box #next").click();
      }
      const dayCell = page.locator(daySelector);
      if (await dayCell.count() === 0 || /past|disabled/.test(await dayCell.getAttribute("class") ?? "")) {
        return errorResult(request, "invalid_request");
      }
      await dayCell.click();
    }
    const response = await responsePromise;
    if (!response) return errorResult(request, "provider_timeout");
    if (response.status() === 429) return errorResult(request, "rate_limited");
    if (!response.ok()) return errorResult(request, "network_error");
    // The endpoint response is a site-specific fragment. Read the form's
    // rendered options after its own handler applies that response.
    await page.waitForTimeout(300);
    const options = await page.locator("#time-field option").evaluateAll((elements) =>
      elements.map((element) => { const option = element as HTMLOptionElement;
        return { value: option.value, text: option.textContent?.trim() ?? "",
          disabled: option.disabled }; }));
    const parsed = parseChopeTimeOptions(options);
    if (parsed.status === "error") {
      logWarn("chope.availability_parse_failed", { clientId: request.clientId,
        outletId: request.outletId, optionCount: options.length,
        optionSample: options.slice(0, 2) });
      return errorResult(request, "unexpected_response");
    }
    const observedAt = new Date();
    const futureSlots = parsed.slots.filter((slot) =>
      new Date(`${request.date}T${slot}:00+08:00`).getTime() > observedAt.getTime());
    const result: AvailabilityResult = { outletId: request.outletId, date: request.date,
      partySize: request.partySize, availableSlots: futureSlots,
      timezone: "Asia/Singapore", provider: "chope", observedAt: observedAt.toISOString(),
      status: futureSlots.length ? "available" : "unavailable" };
    logInfo("chope.availability_observed", { clientId: request.clientId,
      outletId: request.outletId, date: request.date, partySize: request.partySize,
      status: result.status, slotCount: result.availableSlots.length });
    return result;
  } catch (error) {
    logWarn("chope.availability_read_failed", { clientId: request.clientId,
      outletId: request.outletId,
      failureClass: timedOut || error instanceof Error && /timeout/i.test(error.message)
        ? "provider_timeout" : "network_error" });
    return errorResult(request, timedOut || error instanceof Error && /timeout/i.test(error.message)
      ? "provider_timeout" : "network_error");
  } finally {
    turnSignal?.removeEventListener("abort", abortRead);
    if (timeout) clearTimeout(timeout);
    await browser?.close().catch(() => undefined);
  }
}
