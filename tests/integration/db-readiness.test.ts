import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getPool, query } from "@/lib/db";
import { enterTenantContext } from "@/lib/tenant-context";
import { getConversationDecisionTraces } from "@/lib/conversation-decision-traces";

const execFileAsync = promisify(execFile);
const dbDescribe = process.env.PRONTO_RUN_DB_TESTS === "1" ? describe : describe.skip;
const seedClientId = "00000000-0000-4000-8000-000000000001";

dbDescribe("DB-backed release readiness", () => {
  it("loads the business decision diagnostics against the real schema", async () => {
    enterTenantContext({role:'client',clientId:seedClientId});
    await expect(getConversationDecisionTraces(seedClientId,randomUUID())).resolves.toEqual([]);
  });
  afterEach(() => {
    enterTenantContext({ role: "operator", clientId: null });
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("has applied migrations and installed pgvector", async () => {
    const migrations = await getPool().query<{ count: string }>(
      "select count(*) from schema_migrations",
    );
    const vector = await getPool().query<{ installed: boolean }>(
      "select exists (select 1 from pg_extension where extname = 'vector') as installed",
    );

    expect(Number(migrations.rows[0].count)).toBeGreaterThanOrEqual(27);
    expect(vector.rows[0].installed).toBe(true);
  });

  it("seed creates operator and client logins", async () => {
    const users = await getPool().query<{ email: string; role: string; client_id: string | null }>(
      `
        select email, role, client_id
        from users
        where email in ('operator@pronto.sg', 'owner@northbridgenasi.sg')
        order by email
      `,
    );

    expect(users.rows).toEqual([
      {
        email: "operator@pronto.sg",
        role: "operator",
        client_id: null,
      },
      {
        email: "owner@northbridgenasi.sg",
        role: "client",
        client_id: seedClientId,
      },
    ]);
  });

  it("encrypts plaintext channel credentials through the backfill script", async () => {
    const channelId = randomUUID();
    await getPool().query(
      `
        insert into channels (id, client_id, kind, name, status, external_id, credentials, settings)
        values ($1, $2, 'whatsapp', 'Encryption test', 'active', $3, $4, $5)
      `,
      [
        channelId,
        seedClientId,
        `encryption-test-${channelId}`,
        { accessToken: "plaintext-token", phoneNumberId: "phone-id", appSecret: "secret" },
        { verifyToken: "verify", ownerPhone: "6590000000" },
      ],
    );

    try {
      await execFileAsync("pnpm", ["channels:encrypt-credentials"], {
        cwd: process.cwd(),
        env: process.env,
      });

      const encrypted = await getPool().query<{
        credentials: Record<string, unknown>;
        encrypted_credentials: string | null;
        credentials_encryption_nonce: string | null;
        credentials_encryption_tag: string | null;
      }>(
        `
          select credentials, encrypted_credentials, credentials_encryption_nonce, credentials_encryption_tag
          from channels
          where id = $1
        `,
        [channelId],
      );

      expect(encrypted.rows[0].credentials).toEqual({});
      expect(encrypted.rows[0].encrypted_credentials).toBeTruthy();
      expect(encrypted.rows[0].credentials_encryption_nonce).toBeTruthy();
      expect(encrypted.rows[0].credentials_encryption_tag).toBeTruthy();
    } finally {
      await getPool().query("delete from channels where id = $1", [channelId]);
    }
  });

  it("preflight rejects leftover active plaintext channel credentials", async () => {
    const channelId = randomUUID();
    await getPool().query(
      `
        insert into channels (id, client_id, kind, name, status, external_id, credentials, settings)
        values ($1, $2, 'telegram', 'Plaintext test', 'active', $3, $4, $5)
      `,
      [
        channelId,
        seedClientId,
        `plaintext-test-${channelId}`,
        { botToken: "plaintext-token" },
        { webhookSecret: "secret", ownerChatId: "123456" },
      ],
    );

    try {
      await expect(
        execFileAsync("pnpm", ["preflight:ci"], {
          cwd: process.cwd(),
          env: process.env,
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining("plaintext credentials"),
      });
    } finally {
      await getPool().query("delete from channels where id = $1", [channelId]);
    }
  });

  it("enforces tenant guard against representative real queries before pg", async () => {
    enterTenantContext({ role: "client", clientId: seedClientId });

    await expect(
      query("select * from messages where conversation_id = $1", [
        "00000000-0000-4000-8000-000000000401",
      ]),
    ).rejects.toThrow("client_id");

    await expect(
      query("select * from messages where conversation_id = $1 and client_id = $2", [
        "00000000-0000-4000-8000-000000000401",
        seedClientId,
      ]),
    ).resolves.toMatchObject({ rows: expect.any(Array) });
  });
});
