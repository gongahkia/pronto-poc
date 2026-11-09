import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the reader's browser orchestration without making provider requests.
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));

const config = { clientId: "tenant-a", outletId: "restaurant-a",
  listingUrl: "https://www.chope.co/singapore-restaurants/restaurant/restaurant-a",
  authorizedAt: "2026-10-25T00:00:00Z", scope: "demo_availability" as const };
const request = { clientId: "tenant-a", outletId: "restaurant-a", date: "2026-10-26",
  time: "19:00", partySize: 4 };
const endpoint = "https://www.chope.co/singapore-restaurants/categories/get_times";
const fields = "rid=restaurant-a&date=26-10-2026&adults=4&children=0";
type Route = { request: () => { url: () => string; method: () => string; postData: () => string | null };
  continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };

function browserFixture(settings: { listingStatus?: number; readStatus?: number;
  noResponse?: boolean; outletId?: string; unavailable?: boolean; malformed?: boolean; requestFields?: string } = {}) {
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const selectOption = vi.fn(async () => undefined);
  const locator = (selector: string) => ({
    count: vi.fn(async () => selector.startsWith("iframe") ? 0 : 1),
    inputValue: vi.fn(async () => settings.outletId ?? config.outletId),
    click: vi.fn(async () => undefined), selectOption,
    dispatchEvent: vi.fn(async () => undefined), getAttribute: vi.fn(async () => ""),
    evaluateAll: vi.fn(async () => settings.malformed ? [] : settings.unavailable
      ? [{ value: "Not Available", text: "Not Available", disabled: false }]
      : [{ value: "7:00pm", text: "7:00pm", disabled: false }]),
  });
  const response = { url: () => endpoint,
    request: () => ({ method: () => "POST", postData: () => settings.requestFields ?? fields }),
    status: () => settings.readStatus ?? 200, ok: () => (settings.readStatus ?? 200) === 200 };
  const page = { setDefaultTimeout: vi.fn(), locator: vi.fn(locator),
    goto: vi.fn(async () => ({ status: () => settings.listingStatus ?? 200,
      ok: () => (settings.listingStatus ?? 200) === 200 })),
    waitForResponse: vi.fn(async (predicate: (value: typeof response) => boolean) => {
      expect(predicate(response)).toBe(true);
      return settings.noResponse ? null : response;
    }), waitForTimeout: vi.fn(async () => undefined) };
  const context = { newPage: vi.fn(async () => page),
    route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => { routeHandler = handler; }) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) };
  mocks.launch.mockResolvedValue(browser);
  return { browser, page, selectOption, async route(url: string, method = "GET", body: string | null = null) {
    const route = { request: () => ({ url: () => url, method: () => method, postData: () => body }),
      continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    await routeHandler?.(route);
    return route;
  } };
}

beforeEach(() => {
  vi.resetModules(); mocks.launch.mockReset();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T04:00:00Z"));
  vi.stubEnv("PRONTO_CHOPE_LIVE_READS", "1"); vi.stubEnv("CHOPE_LIVE_READ_APPROVED", "1");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Chope browser reader with a simulated browser transport", () => {
  it("rejects tenant, outlet and invalid parameter access before launching Chromium", async () => {
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    for (const override of [{ clientId: "tenant-b" }, { outletId: "restaurant-b" }]) {
      expect(await readChopeBrowserAvailability({ ...request, ...override }, config))
        .toMatchObject({ status: "error", errorCode: "missing_authorization" });
    }
    expect(await readChopeBrowserAvailability({ ...request, partySize: 21 }, config))
      .toMatchObject({ status: "error", errorCode: "invalid_request" });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("returns only parsed provider slots with scope and observation time, then closes Chromium", async () => {
    const fixture = browserFixture();
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    expect(await readChopeBrowserAvailability(request, config)).toEqual({
      outletId: request.outletId, date: request.date, partySize: 4, availableSlots: ["19:00"],
      timezone: "Asia/Singapore", provider: "chope", observedAt: "2026-10-25T04:00:00.000Z",
      status: "available" });
    expect(fixture.page.goto).toHaveBeenCalledWith(config.listingUrl, expect.anything());
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("closes an in-flight browser when the shared turn expires", async()=>{
    const fixture=browserFixture();
    fixture.page.goto.mockImplementation(()=>new Promise(()=>{}));
    const {withAgentTurn}=await import("@/lib/agent/turn-budget");
    const {readChopeBrowserAvailability}=await import("@/lib/reservations/chope-browser");
    const work=withAgentTurn(()=>readChopeBrowserAvailability(request,config),{timeoutMs:10});
    const rejected=expect(work).rejects.toMatchObject({reason:"deadline"});
    await vi.advanceTimersByTimeAsync(11);await rejected;
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("reads date/party availability without fabricating a preferred time", async () => {
    const fixture = browserFixture();
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    expect(await readChopeBrowserAvailability({ ...request, time: undefined }, config))
      .toMatchObject({ status: "available", availableSlots: ["19:00"] });
    expect(fixture.page.goto).toHaveBeenCalledWith(config.listingUrl, expect.anything());
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
  it("recognizes the live site's unpadded date in both the response and read-request gate", async () => {
    const body = fields.replace("26-10-2026", "9-11-2026");
    const fixture = browserFixture({ requestFields: body });
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    expect(await readChopeBrowserAvailability({ ...request, date: "2026-11-09" }, config)).toMatchObject({ status: "available" });
    expect((await fixture.route(endpoint, "POST", body.replace("9-11", "8-11"))).abort).toHaveBeenCalledOnce();
    expect((await fixture.route(endpoint, "POST", body)).continue).toHaveBeenCalledOnce();
    expect((await fixture.route(endpoint, "POST", body)).abort).toHaveBeenCalledOnce();
  });
  it("starts a read for the default today/two-adult selections when none started automatically", async () => {
    const fixture = browserFixture({ requestFields: fields.replace("26-10-2026", "25-10-2026").replace("adults=4", "adults=2") });
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    expect(await readChopeBrowserAvailability({ ...request, date: "2026-10-25", partySize: 2 }, config)).toMatchObject({ status: "available" });
    expect(fixture.selectOption).toHaveBeenCalledWith("2");
  });

  it.each([
    [{ unavailable: true }, "unavailable", undefined],
    [{ malformed: true }, "error", "unexpected_response"],
    [{ listingStatus: 429 }, "error", "rate_limited"],
    [{ listingStatus: 503 }, "error", "network_error"],
    [{ readStatus: 429 }, "error", "rate_limited"],
    [{ readStatus: 503 }, "error", "network_error"],
    [{ noResponse: true }, "error", "provider_timeout"],
    [{ outletId: "restaurant-b" }, "error", "missing_authorization"],
  ] as const)("handles provider state %j without inventing slots", async (settings, status, errorCode) => {
    browserFixture(settings);
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    const result = await readChopeBrowserAvailability(request, config);
    expect(result).toMatchObject({ status, availableSlots: [] });
    expect(result.errorCode).toBe(errorCode);
    if (status === "error") expect(result.observedAt).toBeNull();
  });

  it("reserves the per-process interval before launch, including a failed launch", async () => {
    mocks.launch.mockRejectedValue(new Error("Simulated launch failure"));
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    expect(await readChopeBrowserAvailability(request, config)).toMatchObject({ errorCode: "network_error" });
    expect(await readChopeBrowserAvailability(request, config)).toMatchObject({ errorCode: "rate_limited" });
    expect(mocks.launch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await readChopeBrowserAvailability(request, config);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it("closes a stalled page at the read deadline and returns unknown/error, never unavailable", async () => {
    const fixture = browserFixture();
    let rejectNavigation: (error: Error) => void = () => undefined;
    fixture.page.goto.mockImplementation(() => new Promise((_resolve, reject) => { rejectNavigation = reject; }));
    fixture.browser.close.mockImplementation(async () => { rejectNavigation(new Error("Browser closed")); });
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    const pending = readChopeBrowserAvailability(request, config);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ status: "error", errorCode: "provider_timeout", availableSlots: [] });
    expect(fixture.browser.close).toHaveBeenCalled();
  });

  it("allows one exact availability POST and blocks booking writes, alternate hosts and duplicate scope fields", async () => {
    const fixture = browserFixture();
    const { readChopeBrowserAvailability } = await import("@/lib/reservations/chope-browser");
    await readChopeBrowserAvailability(request, config);
    expect((await fixture.route(config.listingUrl)).continue).toHaveBeenCalledOnce();
    for (const [url, method, body] of [
      ["https://book.chope.co/booking", "GET", null],
      ["https://booking.chope.co/booking_index", "GET", null],
      ["https://bookv5.chope.co/booking", "GET", null],
      ["https://www.chope.co/booking_index", "GET", null],
      ["https://www.chope.co/%62ooking_index", "GET", null],
      ["https://www.chope.co/%zz", "GET", null],
      ["https://www.chope.co/payment", "POST", fields],
      ["https://evil.example/", "GET", null],
      ["https://www.chope.co.evil.example/", "GET", null],
      [`${endpoint}?operation=booking`, "POST", fields],
      [endpoint, "POST", `${fields}&rid=restaurant-b`],
      [endpoint, "POST", fields.replace("adults=4", "adults=2")],
      [endpoint, "POST", fields.replace("26-10", "27-10")],
      [endpoint, "POST", fields.replace("children=0", "children=1")],
      [endpoint, "DELETE", fields],
    ] as const) {
      expect((await fixture.route(url, method, body)).abort).toHaveBeenCalledOnce();
    }
    expect((await fixture.route(endpoint, "POST", fields)).continue).toHaveBeenCalledOnce();
    expect((await fixture.route(endpoint, "POST", fields)).abort).toHaveBeenCalledOnce();
  });
});
