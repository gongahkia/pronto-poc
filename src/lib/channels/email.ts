import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { query, type Queryable } from "@/lib/db";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "@/lib/channels/credentials";
import { AmbiguousProviderAcceptanceError, ProviderSendError } from "@/lib/channels/provider-error";
import type { NormalizedInboundMessage } from "@/lib/channels/types";
import type { Channel } from "@/lib/types";

export type EmailProviderKind = "postmark" | "resend" | "local_smtp";

export type EmailHeaders = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  autoSubmitted: string | null;
  precedence: string | null;
  authenticationResults: string | null;
  listUnsubscribe: string | null;
};

export type ParsedEmail = {
  provider: EmailProviderKind;
  providerMessageId: string;
  rfcMessageId: string | null;
  fromAddress: string;
  fromName: string | undefined;
  to: string[];
  cc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  attachments: { name: string; contentType: string | null; size: number | null }[];
  headers: EmailHeaders;
};

const AUTH_FAIL_REGEX = /(spf|dkim|dmarc)\s*=\s*(fail|softfail|policy)/i;

export function verifyEmailWebhookSignature(input: {
  provider: EmailProviderKind;
  rawBody: string;
  signatureHeader: string | null;
  secret: string | undefined;
}): boolean {
  if (!input.secret) return false;
  if (!input.signatureHeader) {
    return false;
  }
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const provided = input.signatureHeader.replace(/^sha256=/, "");
  const providedBuf = Buffer.from(provided, "hex");
  return (
    expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
  );
}

export function parseEmailPayload(
  provider: EmailProviderKind,
  payload: Record<string, unknown>,
): ParsedEmail | null {
  if (provider === "postmark") return parsePostmark(payload);
  if (provider === "resend") return parseResend(payload);
  return null;
}

export async function normalizeEmailPayload(
  channelId: string,
  provider: EmailProviderKind,
  payload: Record<string, unknown>,
  supportAddress?: string,
): Promise<NormalizedInboundMessage[]> {
  const parsed = parseEmailPayload(provider, payload);
  if (!parsed) return [];

  return normalizeParsedEmail(channelId, parsed, supportAddress);
}

export async function normalizeParsedEmail(
  channelId: string,
  parsed: ParsedEmail,
  supportAddress?: string,
): Promise<NormalizedInboundMessage[]> {
  if (!safeEmailAddress(parsed.fromAddress)) return [];
  if (supportAddress) {
    const expected = supportAddress.toLowerCase();
    if (![...parsed.to, ...parsed.cc].includes(expected) || parsed.fromAddress === expected) return [];
  }

  if (isAutoResponder(parsed.headers, parsed.subject)) {
    return [];
  }

  const externalMessageId = parsed.rfcMessageId ?? parsed.providerMessageId;
  const externalThreadId = await resolveThreadId(channelId, parsed);

  const text = pickInboundText(parsed);
  const hasAttachments = parsed.attachments.length > 0;
  const dmarcFailed = isAuthFail(parsed.headers.authenticationResults);

  let unsupportedMediaType: string | undefined;
  let body: string;
  if (text && text.length > 4000) {
    unsupportedMediaType = "email_oversize";
    body = "[Email body exceeded the 4,000-character support limit; staff review required.]";
  } else if (!text && hasAttachments) {
    unsupportedMediaType = "email_attachment";
    body = `[Unsupported email content: ${parsed.attachments
      .map((attachment) => attachment.name)
      .join(", ")}]`;
  } else if (!text) {
    return [];
  } else if (hasAttachments) {
    unsupportedMediaType = "email_attachment";
    body = `${text}\n\n[Attached files ignored: ${parsed.attachments
      .map((attachment) => attachment.name)
      .join(", ")}]`;
  } else if (dmarcFailed) {
    unsupportedMediaType = "email_auth_failed";
    body = `${text}\n\n[Sender authentication failed]`;
  } else {
    body = text;
  }

  return [
    {
      channelId,
      channelKind: "email",
      externalMessageId,
      externalThreadId,
      customerHandle: parsed.fromAddress,
      customerName: parsed.fromName,
      text: body,
      unsupportedMediaType,
      raw: {
        provider: parsed.provider,
        parsed,
      },
    },
  ];
}

const MAX_LOCAL_EMAIL_BYTES = 1024 * 1024;
export async function parseLocalRfc822(raw: Buffer): Promise<ParsedEmail> {
  if (!raw.length || raw.length > MAX_LOCAL_EMAIL_BYTES) throw new Error("Local email exceeds the 1 MiB limit.");
  const mail = await simpleParser(raw, { skipImageLinks: true });
  const fromAddress = mail.from?.value[0]?.address?.toLowerCase();
  const to = mail.to ? (Array.isArray(mail.to) ? mail.to : [mail.to]) : [];
  const cc = mail.cc ? (Array.isArray(mail.cc) ? mail.cc : [mail.cc]) : [];
  if (!fromAddress || !mail.date && !mail.messageId) throw new Error("Local email lacks a usable sender or identity.");
  const header = (key: string) => {
    const value = mail.headers.get(key);
    return typeof value === "string" ? value : null;
  };
  const messageId = bracketTrim(mail.messageId ?? undefined);
  return {
    provider: "local_smtp",
    providerMessageId: messageId ?? createHash("sha256").update(raw).digest("hex"),
    rfcMessageId: messageId,
    fromAddress, fromName: mail.from?.value[0]?.name || undefined,
    to: to.flatMap((entry) => entry.value.map((value) => value.address?.toLowerCase()).filter((value): value is string => Boolean(value))),
    cc: cc.flatMap((entry) => entry.value.map((value) => value.address?.toLowerCase()).filter((value): value is string => Boolean(value))),
    subject: mail.subject ?? "", text: mail.text ?? null,
    html: typeof mail.html === "string" ? mail.html : null,
    attachments: mail.attachments.map((attachment) => ({
      name: attachment.filename ?? "unnamed", contentType: attachment.contentType ?? null,
      size: attachment.size ?? null,
    })),
    headers: {
      messageId,
      inReplyTo: bracketTrim(mail.inReplyTo ?? undefined),
      references: (Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])
        .map((value) => bracketTrim(value)).filter((value): value is string => Boolean(value)),
      autoSubmitted: header("auto-submitted"), precedence: header("precedence"),
      authenticationResults: header("authentication-results"),
      listUnsubscribe: header("list-unsubscribe"),
    },
  };
}

function parsePostmark(payload: Record<string, unknown>): ParsedEmail | null {
  const providerMessageId = stringValue(payload.MessageID);
  const from = stringValue(payload.From);
  if (!providerMessageId || !from) return null;

  const headers = extractPostmarkHeaders(
    Array.isArray(payload.Headers) ? (payload.Headers as unknown[]) : [],
  );

  const fromName = stringValue(payload.FromName);
  const fromAddress = extractAddress(from);
  const subject = stringValue(payload.Subject) ?? "";
  const text = stringValue(payload.TextBody) ?? stringValue(payload.StrippedTextReply);
  const html = stringValue(payload.HtmlBody);
  const to = parseAddressList(payload.ToFull, payload.To);
  const cc = parseAddressList(payload.CcFull, payload.Cc);
  const attachments = Array.isArray(payload.Attachments)
    ? (payload.Attachments as Record<string, unknown>[]).map((attachment) => ({
        name: stringValue(attachment.Name) ?? "unnamed",
        contentType: stringValue(attachment.ContentType) ?? null,
        size: typeof attachment.ContentLength === "number" ? attachment.ContentLength : null,
      }))
    : [];

  return {
    provider: "postmark",
    providerMessageId,
    rfcMessageId: headers.messageId,
    fromAddress: fromAddress ?? from,
    fromName: fromName ?? undefined,
    to,
    cc,
    subject,
    text: text ?? null,
    html: html ?? null,
    attachments,
    headers,
  };
}

function parseResend(payload: Record<string, unknown>): ParsedEmail | null {
  const data = isRecord(payload.data) ? payload.data : payload;
  const providerMessageId =
    stringValue(data.email_id) ?? stringValue(data.id);
  const from = stringValue(data.from);
  if (!providerMessageId || !from) return null;

  const headerSource = isRecord(data.headers) ? data.headers : {};
  const headers = extractGenericHeaders(headerSource);
  const subject = stringValue(data.subject) ?? "";
  const text = stringValue(data.text);
  const html = stringValue(data.html);
  const to = listFromUnknown(data.to);
  const cc = listFromUnknown(data.cc);
  const attachments = Array.isArray(data.attachments)
    ? (data.attachments as Record<string, unknown>[]).map((attachment) => ({
        name: stringValue(attachment.filename) ?? "unnamed",
        contentType: stringValue(attachment.content_type) ?? null,
        size: typeof attachment.size === "number" ? attachment.size : null,
      }))
    : [];

  return {
    provider: "resend",
    providerMessageId,
    rfcMessageId: headers.messageId,
    fromAddress: extractAddress(from) ?? from,
    fromName: undefined,
    to,
    cc,
    subject,
    text: text ?? null,
    html: html ?? null,
    attachments,
    headers,
  };
}

function extractPostmarkHeaders(headers: unknown[]): EmailHeaders {
  const map = new Map<string, string>();
  for (const entry of headers) {
    if (!isRecord(entry)) continue;
    const name = stringValue(entry.Name);
    const value = stringValue(entry.Value);
    if (!name || !value) continue;
    map.set(name.toLowerCase(), value);
  }
  return mapToHeaders(map);
}

function extractGenericHeaders(headers: Record<string, unknown>): EmailHeaders {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") map.set(key.toLowerCase(), value);
  }
  return mapToHeaders(map);
}

function mapToHeaders(map: Map<string, string>): EmailHeaders {
  const messageId = bracketTrim(map.get("message-id"));
  const inReplyTo = bracketTrim(map.get("in-reply-to"));
  const referencesRaw = map.get("references");
  const references = referencesRaw
    ? referencesRaw
        .split(/\s+/)
        .map((ref) => bracketTrim(ref))
        .filter((ref): ref is string => Boolean(ref))
    : [];
  return {
    messageId,
    inReplyTo,
    references,
    autoSubmitted: map.get("auto-submitted") ?? null,
    precedence: map.get("precedence") ?? null,
    authenticationResults: map.get("authentication-results") ?? null,
    listUnsubscribe: map.get("list-unsubscribe") ?? null,
  };
}

function isAutoResponder(headers: EmailHeaders, subject: string): boolean {
  if (headers.autoSubmitted && headers.autoSubmitted.toLowerCase() !== "no") return true;
  if (headers.precedence) {
    const value = headers.precedence.toLowerCase();
    if (value === "bulk" || value === "list" || value === "junk" || value === "auto_reply") {
      return true;
    }
  }
  if (headers.listUnsubscribe) {
    return true;
  }
  if (/^(out of office|automatic reply|auto-?reply|away from office)\b/i.test(subject.trim())) {
    return true;
  }
  return false;
}

function isAuthFail(authResults: string | null): boolean {
  if (!authResults) return false;
  return AUTH_FAIL_REGEX.test(authResults);
}

function pickInboundText(parsed: ParsedEmail): string | null {
  const text = parsed.text?.trim();
  if (text) return text;
  const html = parsed.html;
  if (!html) return null;
  return stripHtml(html);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function resolveThreadId(channelId: string, parsed: ParsedEmail): Promise<string> {
  const candidates: string[] = [];
  if (parsed.headers.inReplyTo) candidates.push(parsed.headers.inReplyTo);
  candidates.push(...parsed.headers.references);
  if (candidates.length) {
    const result = await query<{ external_thread_id: string }>(
      `
        select c.external_thread_id
        from conversations c
        join messages m on m.conversation_id = c.id
        where c.channel_id = $1
          and lower(c.customer_handle) = lower($3)
          and (
            m.external_message_id = any($2::text[])
            or m.metadata->>'rfcMessageId' = any($2::text[])
            or trim(both '<>' from m.metadata->>'outgoingMessageId') = any($2::text[])
          )
        order by m.created_at desc
        limit 1
      `,
      [channelId, candidates, parsed.fromAddress],
    );
    const match = result.rows[0]?.external_thread_id;
    if (match) return match;
  }
  return `${parsed.fromAddress.toLowerCase()}:${parsed.rfcMessageId ?? parsed.providerMessageId}`;
}

function bracketTrim(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "");
  return trimmed.length ? trimmed : null;
}

function extractAddress(value: string): string | null {
  const angle = /<([^>]+)>/.exec(value);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  return value.trim().toLowerCase() || null;
}

function parseAddressList(...sources: unknown[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (isRecord(entry) && typeof entry.Email === "string") {
          out.push(entry.Email.toLowerCase());
        } else if (typeof entry === "string") {
          const addr = extractAddress(entry);
          if (addr) out.push(addr);
        }
      }
    } else if (typeof source === "string") {
      for (const part of source.split(/[,;]/)) {
        const addr = extractAddress(part);
        if (addr) out.push(addr);
      }
    }
  }
  return Array.from(new Set(out));
}

function listFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => extractAddress(entry))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
  }
  if (typeof value === "string") return parseAddressList(value);
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export async function isEmailSuppressed(input: {
  clientId: string;
  emailAddress: string;
}, db: Queryable = { query }): Promise<boolean> {
  try {
    const result = await db.query<{ id: string }>(
      "select id from email_suppressions where client_id = $1 and lower(email_address) = lower($2) limit 1",
      [input.clientId, input.emailAddress],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "42P01"
    ) {
      return false;
    }
    throw error;
  }
}

export async function suppressEmailAddress(input: {
  clientId: string;
  emailAddress: string;
  reason: string;
  provider?: string;
  raw?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `
      insert into email_suppressions (client_id, email_address, reason, provider, raw)
      values ($1, $2, $3, $4, $5)
      on conflict (client_id, email_address) do update set
        reason = excluded.reason,
        provider = excluded.provider,
        raw = excluded.raw,
        created_at = now()
    `,
    [
      input.clientId,
      input.emailAddress.toLowerCase(),
      input.reason,
      input.provider ?? null,
      input.raw ?? {},
    ],
  );
}

export async function lookupReplyThreadingHints(input: {
  channelId: string;
  clientId: string;
  externalThreadId: string;
}, db: Queryable = { query }): Promise<{
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  to: string;
}> {
  const result = await db.query<{
    body: string;
    metadata: Record<string, unknown>;
    external_message_id: string;
    customer_handle: string | null;
  }>(
    `
      select m.body, m.metadata, m.external_message_id, c.customer_handle
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.channel_id = $1
        and c.external_thread_id = $2
        and c.client_id = $3 and m.client_id = $3
        and m.sender_role = 'customer'
      order by m.created_at desc
      limit 1
    `,
    [input.channelId, input.externalThreadId, input.clientId],
  );
  const row = result.rows[0];
  if (!row?.customer_handle) throw new Error("Email conversation has no verified customer recipient.");

  const raw = isRecord(row.metadata) ? (row.metadata.raw as Record<string, unknown> | undefined) : undefined;
  const parsed = raw && isRecord(raw.parsed) ? (raw.parsed as ParsedEmail) : null;
  const inReplyTo = parsed?.rfcMessageId ?? null;
  const references = parsed?.headers.references ?? [];
  const subject = parsed?.subject ?? null;
  return {
    inReplyTo,
    references: inReplyTo ? Array.from(new Set([...references, inReplyTo])) : references,
    subject,
    to: row.customer_handle,
  };
}

export type EmailSendOptions = {
  channel: Channel;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  fetchFn?: typeof fetch;
};

export async function sendEmail(input: EmailSendOptions, db: Queryable = { query }): Promise<{ messageId: string }> {
  const provider =
    (input.channel.credentials.provider as EmailProviderKind | undefined) ?? "postmark";
  if (!["postmark", "resend", "local_smtp"].includes(provider)) throw new Error("Unsupported email provider.");
  const apiKey =
    (input.channel.credentials.apiKey as string | undefined) ??
    (provider === "postmark" ? process.env.POSTMARK_API_TOKEN : provider === "resend" ? process.env.RESEND_API_KEY : undefined);
  const from =
    (input.channel.credentials.fromAddress as string | undefined) ??
    (provider === "postmark" ? process.env.POSTMARK_FROM_ADDRESS : provider === "resend" ? process.env.RESEND_FROM_ADDRESS : undefined);

  if ((provider !== "local_smtp" && !apiKey) || !from) {
    throw new Error(`Email credentials missing for provider ${provider}; outbound send skipped.`);
  }
  if (!safeEmailAddress(from) || !safeEmailAddress(input.to) || /[\r\n]/.test(input.subject) ||
    input.references?.some((value) => /[\r\n]/.test(value)) ||
    (input.inReplyTo && /[\r\n]/.test(input.inReplyTo))) {
    throw new Error("Email headers contain an invalid address or newline.");
  }

  if (await isEmailSuppressed({ clientId: input.channel.client_id, emailAddress: input.to }, db)) {
    throw new Error("Email recipient is on the suppression list.");
  }

  const outboundMessageId = buildOutboundMessageId(from);
  const subject = ensureReSubject(input.subject);
  const headerMap = buildOutboundHeaderMap({
    messageId: outboundMessageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });
  const fetchImpl = input.fetchFn ?? fetch;

  if (provider === "local_smtp") {
    if (process.env.NODE_ENV === "production" || process.env.PRONTO_LOCAL_EMAIL_ENABLED !== "1") {
      throw new Error("Local SMTP is disabled outside the explicit development sandbox.");
    }
    const port = Number(process.env.PRONTO_LOCAL_SMTP_PORT ?? 1025);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local SMTP port.");
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false,
      ignoreTLS: true, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000 });
    try {
      try { await transport.verify(); }
      catch { throw new Error("Local SMTP sandbox was unavailable before send; safe to retry."); }
      const sent = await transport.sendMail({ from, to: input.to, subject, text: input.text,
        messageId: outboundMessageId, headers: headerMap });
      if (!sent.accepted.includes(input.to)) throw new ProviderSendError("Local SMTP", 550);
    } catch (error) {
      if (error instanceof ProviderSendError ||
          (error instanceof Error && error.message === "Local SMTP sandbox was unavailable before send; safe to retry."))
        throw error;
      throw new AmbiguousProviderAcceptanceError("Local SMTP");
    } finally { transport.close(); }
    return { messageId: outboundMessageId };
  }

  if (provider === "postmark") {
    const response = await boundedEmailFetch(fetchImpl, "https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": apiKey ?? "",
      },
      body: JSON.stringify({
        From: from,
        To: input.to,
        Subject: subject,
        TextBody: input.text,
        MessageStream: "outbound",
        Headers: Object.entries(headerMap).map(([Name, Value]) => ({ Name, Value })),
      }),
    });
    if (!response.ok) {
      throw new ProviderSendError("Postmark", response.status);
    }
    return { messageId: outboundMessageId };
  }

  const response = await boundedEmailFetch(fetchImpl, "https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      text: input.text,
      headers: headerMap,
    }),
  });
  if (!response.ok) {
    throw new ProviderSendError("Resend", response.status);
  }
  return { messageId: outboundMessageId };
}

async function boundedEmailFetch(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try { return await fetchFn(url, { ...init, signal: controller.signal }); }
  catch { throw new AmbiguousProviderAcceptanceError("Email"); }
  finally { clearTimeout(timer); }
}

function buildOutboundMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "pronto.sg";
  return `<${randomUUID()}@${domain}>`;
}

function buildOutboundHeaderMap(input: {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Message-Id": input.messageId,
    "Auto-Submitted": "auto-replied",
    "X-Auto-Response-Suppress": "All",
  };
  if (input.inReplyTo) {
    headers["In-Reply-To"] = ensureAngleBrackets(input.inReplyTo);
  }
  const references = (input.references ?? []).map(ensureAngleBrackets);
  if (references.length) {
    headers.References = references.join(" ");
  }
  return headers;
}

function ensureAngleBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

function ensureReSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: your inquiry";
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

export async function getEmailChannel(channelId: string): Promise<Channel | null> {
  const result = await query<Channel>(
    "select * from channels where id = $1 and kind = 'email'",
    [channelId],
  );
  const row = result.rows[0];
  return row && !usesLegacyPlaintextCredentials(row) ? decryptChannelCredentials(row) : null;
}

function safeEmailAddress(value: string): boolean {
  return /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
