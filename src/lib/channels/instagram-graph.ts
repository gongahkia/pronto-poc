export type InstagramGraphResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; detail: string; uncertain: boolean };

export function isGraphObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function requestInstagramGraph(input: {
  version: string; path: string; token: string; query?: Record<string, string>;
  form?: Record<string, string>; fetchFn?: typeof fetch;
}): Promise<InstagramGraphResult> {
  if (!/^v\d+\.\d+$/.test(input.version) || !/^(debug_token|\d+(\/subscribed_apps)?)$/.test(input.path))
    return { ok: false, detail: "Invalid Instagram Graph request path or version.", uncertain: false };
  const url = new URL(`https://graph.facebook.com/${input.version}/${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
  try {
    const response = await (input.fetchFn ?? fetch)(url, {
      method: input.form ? "POST" : "GET", redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(8_000),
      ...(input.form ? { body: new URLSearchParams(input.form) } : {}),
    });
    const body: unknown = await response.json();
    if (!isGraphObject(body)) return { ok: false, detail: "Meta returned an invalid JSON object.", uncertain: Boolean(input.form) };
    if (!response.ok || isGraphObject(body.error)) {
      const error = isGraphObject(body.error) ? body.error : {};
      const code = typeof error.code === "number" ? `; code ${error.code}` : "";
      const subcode = typeof error.error_subcode === "number" ? `; subcode ${error.error_subcode}` : "";
      return { ok: false, detail: `Meta rejected the request (HTTP ${response.status}${code}${subcode}).`,
        uncertain: Boolean(input.form) && response.status >= 500 };
    }
    return { ok: true, body };
  } catch {
    // raw exceptions can contain token-bearing URLs; never return them or retry.
    return { ok: false, detail: "Meta request failed: network, timeout, redirect, or invalid JSON. No automatic retry.", uncertain: Boolean(input.form) };
  }
}
