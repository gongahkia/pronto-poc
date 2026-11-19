import psCafeBusiness from "../../config/demo-businesses/ps-cafe.json";
import { getPool, vectorLiteral } from "../../src/lib/db";
import { deterministicEmbedding } from "../../src/lib/llm/mock";
import { chunkText } from "../../src/lib/knowledge/chunk";
import { verifyTestDatabase } from "../test-db-safety";
import { encryptedChannelCredentialValues } from "../../src/lib/channels/credentials";
import { hashPassword } from "../../src/lib/password";

// Fixed IDs make this disposable fixture idempotent and easy to remove.
export const PS_CAFE_DEMO_CLIENT_ID = "00000000-0000-4000-8000-00000000a101";
export const PS_CAFE_DEMO_WHATSAPP_ID = "00000000-0000-4000-8000-00000000a102";
export const PS_CAFE_DEMO_INSTAGRAM_ID = "00000000-0000-4000-8000-00000000a103";
export const PS_CAFE_DEMO_EMAIL_ID = "00000000-0000-4000-8000-00000000a104";
export const PS_CAFE_DEMO_MESSENGER_ID = "00000000-0000-4000-8000-00000000a105";
export const PS_CAFE_DEMO_RESPONDER_ID = "00000000-0000-4000-8000-00000000a301";
export const PS_CAFE_DEMO_APPROVER_ID = "00000000-0000-4000-8000-00000000a302";
export const PS_CAFE_DEMO_POLICY_MANAGER_ID = "00000000-0000-4000-8000-00000000a303";
export const PS_CAFE_DEMO_ORDINARY_STAFF_ID = "00000000-0000-4000-8000-00000000a304";
export const PS_CAFE_DEMO_SUPPORT_ADDRESS = "support@ps-cafe-demo.test";
export const PS_CAFE_CHOPE_OUTLET_ID = "pscaferafflescity1808psc";
export const PS_CAFE_CHOPE_URL = "https://www.chope.co/singapore-restaurants/restaurant/ps-cafe-raffles-city";
export const PS_CAFE_DEMO_SLUG = "ps-cafe-raffles-city-demo";
const retrievedAt = "2026-10-11";

export const psCafeDemoSources = psCafeBusiness.knowledge;

export async function setupPsCafeDemo(): Promise<void> {
  await verifyTestDatabase();
  const db = await getPool().connect();
  try {
    await db.query("begin");
    const existing = await db.query<{ slug: string; business_profile: Record<string, unknown> }>(
      "select slug, business_profile from clients where id = $1 for update", [PS_CAFE_DEMO_CLIENT_ID]);
    if (existing.rows[0] && (existing.rows[0].slug !== PS_CAFE_DEMO_SLUG ||
        existing.rows[0].business_profile.demoSeed !== "ps-cafe-raffles-city-v1")) {
      throw new Error("Demo client ID is occupied by non-demo data.");
    }
    const slugOwner = await db.query<{ id: string }>("select id from clients where slug = $1", [PS_CAFE_DEMO_SLUG]);
    if (slugOwner.rows[0] && slugOwner.rows[0].id !== PS_CAFE_DEMO_CLIENT_ID) {
      throw new Error("Demo slug is occupied by another client.");
    }
    const sourceIds = psCafeDemoSources.map((source) => source.id);
    const reservedIds = await db.query<{ client_id: string }>(
      `select client_id from knowledge_sources where id = any($1::uuid[])
       union all select client_id from channels where id = any($2::uuid[])`,
      [sourceIds, [PS_CAFE_DEMO_WHATSAPP_ID, PS_CAFE_DEMO_INSTAGRAM_ID,
        PS_CAFE_DEMO_EMAIL_ID, PS_CAFE_DEMO_MESSENGER_ID]]);
    if (reservedIds.rows.some((row) => row.client_id !== PS_CAFE_DEMO_CLIENT_ID)) {
      throw new Error("Demo source or channel ID is occupied by another tenant.");
    }
    const profile = {
      demoSeed: "ps-cafe-raffles-city-v1", outletName: "PS.Cafe Raffles City",
      address: "252 North Bridge Road, #03-37, Raffles City Shopping Centre, Singapore 179103",
      timezone: "Asia/Singapore", conciergePhone: "+65 6708 9288",
      conciergeEmail: "concierge@pscafe.com",
      chopeBooking: { outletId: PS_CAFE_CHOPE_OUTLET_ID, url: PS_CAFE_CHOPE_URL,
        verifiedAt: "2026-10-11T00:00:00Z" },
      chopeAvailability: { enabled: false, mode: "browser", scope: "demo_availability",
        outletId: PS_CAFE_CHOPE_OUTLET_ID, listingUrl: PS_CAFE_CHOPE_URL,
        authorizedAt: "2026-10-11T00:00:00Z" },
      reservationPolicy: { reviewStatus: "conflict_pending_owner_review",
        weekendPublicHolidayCutoff: null, manualHandoffPartySize: 9,
        directBooking: false, liveAvailability: false },
    };
    await db.query(`insert into clients (id, name, slug, vertical, plan_tier, status, business_profile, brand_voice)
      values ($1, 'PS.Cafe Raffles City', $2, 'fnb', 'trial', 'pilot', $3::jsonb, $4)
      on conflict (id) do update set name = excluded.name, business_profile = excluded.business_profile,
        brand_voice = excluded.brand_voice, updated_at = now()`,
      [PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_SLUG, JSON.stringify(profile),
        "Demonstration default, pending restaurant approval: concise, courteous and clear. State uncertainty and avoid promising unverified outcomes."],
    );
    await db.query(
      `insert into onboarding_stages (client_id, stage)
       select $1, stage from (values ('profile'), ('communications'), ('knowledge'), ('testing'), ('activation')) s(stage)
       on conflict (client_id, stage) do nothing`, [PS_CAFE_DEMO_CLIENT_ID]);
    const demoPasswordHash = await hashPassword("pronto-ps-demo");
    for (const person of [
      { id: PS_CAFE_DEMO_RESPONDER_ID, email: "responder@ps-cafe-demo.test", name: "Demo responder",
        permissions: ["conversation.respond", "conversation.release"] },
      { id: PS_CAFE_DEMO_APPROVER_ID, email: "approver@ps-cafe-demo.test", name: "Demo knowledge approver",
        permissions: ["knowledge.approve"] },
      { id: PS_CAFE_DEMO_POLICY_MANAGER_ID, email: "policy@ps-cafe-demo.test", name: "Demo policy manager",
        permissions: ["escalation.policy.manage"] },
      { id: PS_CAFE_DEMO_ORDINARY_STAFF_ID, email: "staff@ps-cafe-demo.test", name: "Demo staff",
        permissions: [] },
    ]) {
      const claimed = await db.query<{ id: string; client_id: string | null; email: string }>(
        "select id, client_id, email from users where id = $1 or email = $2", [person.id, person.email]);
      if (claimed.rows.some((row) => row.id !== person.id || row.client_id !== PS_CAFE_DEMO_CLIENT_ID || row.email !== person.email))
        throw new Error("A synthetic PS.Cafe staff identity is occupied by non-demo data.");
      await db.query(
        `insert into users (id, client_id, email, name, role, password_hash)
         values ($1, $2, $3, $4, 'client', $5)
         on conflict (id) do update set name = excluded.name, password_hash = excluded.password_hash`,
        [person.id, PS_CAFE_DEMO_CLIENT_ID, person.email, person.name, demoPasswordHash]);
      for (const permission of person.permissions) {
        await db.query(
          `insert into staff_permission_grants (client_id, user_id, permission)
           values ($1, $2, $3) on conflict do nothing`,
          [PS_CAFE_DEMO_CLIENT_ID, person.id, permission]);
      }
    }
    await db.query(`insert into agent_configs (client_id, prompt_preamble, retrieval_threshold,
      response_provider, embedding_provider) values ($1, $2, 0.05, 'openai', 'openai')
      on conflict (client_id) do update set prompt_preamble = excluded.prompt_preamble,
        retrieval_threshold = excluded.retrieval_threshold, updated_at = now()`,
      [PS_CAFE_DEMO_CLIENT_ID, "Answer from this outlet's approved sourced facts and scoped tool observations. Do not invent reservation cutoffs, prices, availability or a confirmed booking. Fresh Chope observations may support an availability check and booking-link referral; customers complete and confirm on Chope. Escalate disputed policies and actions requiring staff."],
    );
    await db.query(`insert into brand_voice_documents (client_id, title, content, attributes, source_notes)
      values ($1, $2, $3, $4::jsonb, $5)
      on conflict (client_id) do update set title = excluded.title, content = excluded.content,
        attributes = excluded.attributes, source_notes = excluded.source_notes, updated_at = now()`,
      [PS_CAFE_DEMO_CLIENT_ID, "PS.Cafe demo voice (unapproved)",
        "Concise, courteous and clear; state uncertainty and avoid promising unverified outcomes.",
        JSON.stringify({ demoDefault: true, approvedByRestaurant: false }),
        "Pronto demonstration default; not presented as PS.Cafe's official brand voice."],
    );
    for (const source of psCafeDemoSources) {
      const metadata = { sourceUrl: source.url, secondaryUrl: "secondaryUrl" in source ? source.secondaryUrl : null,
        retrievedAt, reviewStatus: source.reviewStatus, demoSeed: true,
        ...(source.reviewStatus === "policy_conflict_withheld" ? { conflictingClaims: [
          { cutoff: "17:30", sourceUrl: "https://www.pscafe.com/pscafe-raffles-city/" },
          { cutoff: "18:00", sourceUrl: PS_CAFE_CHOPE_URL },
        ] } : {}) };
      await db.query(`insert into knowledge_sources (id, client_id, title, source_type, content, metadata)
        values ($1, $2, $3, 'curated_demo', $4, $5::jsonb)
        on conflict (id) do update set title = excluded.title, content = excluded.content,
          metadata = excluded.metadata`,
        [source.id, PS_CAFE_DEMO_CLIENT_ID, source.title, source.content, JSON.stringify(metadata)]);
      await db.query("delete from knowledge_chunks where source_id = $1 and client_id = $2",
        [source.id, PS_CAFE_DEMO_CLIENT_ID]);
      for (const [index, chunk] of chunkText(source.content, { maxCharacters: 900, overlap: 120 }).entries()) {
        const embedding = deterministicEmbedding(chunk.content);
        await db.query(`insert into knowledge_chunks (source_id, client_id, chunk_index, content,
          token_estimate, embedding, embedding_model, embedding_dimensions, metadata)
          values ($1, $2, $3, $4, $5, $6::vector, 'text-embedding-3-small', $7, $8::jsonb)`,
          [source.id, PS_CAFE_DEMO_CLIENT_ID, index, chunk.content, chunk.tokenEstimate,
            vectorLiteral(embedding), embedding.length, JSON.stringify(metadata)]);
      }
    }
    for (const channel of [
      { id: PS_CAFE_DEMO_WHATSAPP_ID, kind: "whatsapp", name: "Demo WhatsApp (draft)", externalId: "ps-cafe-demo-phone" },
      { id: PS_CAFE_DEMO_INSTAGRAM_ID, kind: "instagram", name: "Demo Instagram (draft)", externalId: "ps-cafe-demo-ig" },
      { id: PS_CAFE_DEMO_MESSENGER_ID, kind: "messenger", name: "Demo Messenger (draft)", externalId: "ps-cafe-demo-page" },
      { id: PS_CAFE_DEMO_EMAIL_ID, kind: "email", name: "Demo customer email (local SMTP)", externalId: PS_CAFE_DEMO_SUPPORT_ADDRESS },
    ]) {
      await db.query(`insert into channels (id, client_id, kind, name, status, external_id)
        values ($1, $2, $3, $4, 'draft', $5)
        on conflict (id) do update set name = excluded.name, status = 'draft',
          external_id = excluded.external_id, updated_at = now()`,
        [channel.id, PS_CAFE_DEMO_CLIENT_ID, channel.kind, channel.name, channel.externalId]);
    }
    const emailCredentials = encryptedChannelCredentialValues({
      provider: "local_smtp", fromAddress: PS_CAFE_DEMO_SUPPORT_ADDRESS,
    });
    await db.query(`update channels set status = $6, credentials = '{}'::jsonb,
      settings = '{"ownerEmail":"operator@ps-cafe-demo.test","ownerNotificationAudience":"operator"}'::jsonb,
      encrypted_credentials = $3, credentials_encryption_nonce = $4,
      credentials_encryption_tag = $5 where id = $1 and client_id = $2`,
      [PS_CAFE_DEMO_EMAIL_ID, PS_CAFE_DEMO_CLIENT_ID,
        emailCredentials.encryptedCredentials, emailCredentials.nonce, emailCredentials.tag,
        process.env.PRONTO_LOCAL_EMAIL_ENABLED === "1" ? "active" : "draft"]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally { db.release(); }
}

export async function removePsCafeDemo(): Promise<void> {
  await verifyTestDatabase();
  await getPool().query(`delete from clients where id = $1 and slug = $2
    and business_profile ->> 'demoSeed' = 'ps-cafe-raffles-city-v1'`,
    [PS_CAFE_DEMO_CLIENT_ID, PS_CAFE_DEMO_SLUG]);
}
