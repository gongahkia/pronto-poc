import { randomUUID } from "node:crypto";

const SENSITIVE_KEY_PATTERN =
  /authorization|credential|password|secret|signature|token|access[_-]?token|app[_-]?secret|verify[_-]?token|webhook[_-]?secret/i;
const CONTENT_KEY_PATTERN = /body|content|message|payload|raw|text/i;
const PHONE_PATTERN = /(?<![a-zA-Z0-9_])(?:\+?\d[\d\s().-]{6,}\d)(?![a-zA-Z0-9_])/g;
const BEARER_PATTERN = /bearer\s+[a-z0-9._~+/=-]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:access_token|input_token|token|api_key|key|secret|client_secret|app_secret|verify_token|hub\.verify_token|appsecret_proof|signature)=)[^&\s]+/gi;
const INTERNAL_ID_KEYS = new Set(["requestId", "clientId", "channelId", "conversationId", "escalationId",
  "outboundMessageId", "customerMessageId", "agentMessageId", "deliveryAttemptId", "jobId"]);
const INTERNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_HASH_KEYS = new Set(["providerReceiptHash", "providerTraceHash"]);

type LogLevel = "info" | "warn" | "error";

export function requestIdFromRequest(request: Request): string {
  const provided = request.headers.get("x-request-id")?.trim();
  if (provided && /^[a-zA-Z0-9._:-]{8,128}$/.test(provided)) {
    return provided;
  }
  return randomUUID();
}

export function requestIdHeaders(requestId: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("x-request-id", requestId);
  return headers;
}

export function logInfo(event: string, metadata: Record<string, unknown> = {}): void {
  writeLog("info", event, metadata);
}

export function logWarn(event: string, metadata: Record<string, unknown> = {}): void {
  writeLog("warn", event, metadata);
}

export function logError(event: string, metadata: Record<string, unknown> = {}): void {
  writeLog("error", event, metadata);
}

export function redactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

export function redactForLog(value: unknown): unknown {
  return redactValue(value, 0);
}

function writeLog(level: LogLevel, event: string, metadata: Record<string, unknown>): void {
  const redactedMetadata = redactForLog(metadata) as Record<string, unknown>;
  const payload = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...redactedMetadata,
  });

  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 5) {
    return "[redacted-depth]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          return [key, "[redacted]"];
        }
        if (typeof entry === "string" && ((INTERNAL_ID_KEYS.has(key) && INTERNAL_UUID.test(entry)) ||
          (PROVIDER_HASH_KEYS.has(key) && /^sha256:[0-9a-f]{64}$/.test(entry)))) return [key, entry];
        if (CONTENT_KEY_PATTERN.test(key)) {
          return [key, typeof entry === "string" ? "[redacted]" : "[redacted-object]"];
        }
        return [key, redactValue(entry, depth + 1)];
      }),
    );
  }
  return value;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(PHONE_PATTERN, "[redacted-phone]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
