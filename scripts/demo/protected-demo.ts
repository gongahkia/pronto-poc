import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { getPool, transaction } from "../../src/lib/db";
import { protectedDemoConfiguration } from "../../src/lib/deployment-profile";
import { assertCustomerDemoEnabled, DEMO_CLIENT_ID, DEMO_CHANNEL_ID, DEMO_SLUG } from "../../src/lib/customer-demo-boundary";
import { prepareRealDemoEmbeddings } from "../../src/lib/customer-demo-setup";
import { requireRealDemoConfiguration, profileForDemoChoice } from "../../src/lib/customer-demo-ai";
import { hashPassword } from "../../src/lib/password";
import { staffCapabilities } from "../../src/lib/staff-permissions";
import { LOCAL_TEXT_RETRIEVAL_PROFILE } from "../../src/lib/llm/demo-models";
import { assertSavedDemoWorkspaces } from "../../src/lib/demo-business-preflight";
import { demoBusinessScope, LEGACY_DEMO_SCOPE } from "../../src/lib/demo-business";
import { chunkText } from "../../src/lib/knowledge/chunk";
import { recordAuditLog } from "../../src/lib/audit";
import { psCafeDemoSources } from "../demo/ps-cafe-raffles-city";

const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email().regex(/\.(test|invalid)$/i),
  name: z.string().min(1).max(100), role: z.enum(["client","operator"]), password: z.string().min(16).max(256)
    .refine(value => new Set(value).size >= 12 && !/pronto-(ps-demo|operator|client)/i.test(value)) }).strict();

async function bootstrap(path: string) {
  if (JSON.stringify(demoBusinessScope()) !== JSON.stringify(LEGACY_DEMO_SCOPE))
    throw new Error("Legacy bootstrap only supports the original PS.Cafe profile; use demo:business prepare for saved businesses.");
  const settings = protectedDemoConfiguration();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let accounts: z.infer<typeof accountSchema>[];
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 16384)
      throw new Error("Bootstrap input must be an owned regular mode-600 JSON file under 16 KB.");
    accounts = z.array(accountSchema).min(2).max(20).parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
  if (new Set(accounts.map(a => a.id)).size !== accounts.length || new Set(accounts.map(a => a.email.toLowerCase())).size !== accounts.length ||
      accounts.some(a => !settings.allowedUserIds.includes(a.id)) || settings.allowedUserIds.some(id => !accounts.some(a => a.id === id)) ||
      !accounts.some(a => a.role === "operator") || !accounts.some(a => a.role === "client"))
    throw new Error("Bootstrap requires distinct invited synthetic identities with separate operator and business roles.");
  const passwords = await Promise.all(accounts.map(account => hashPassword(account.password)));
  await transaction(async db => {
    await db.query("select pg_advisory_xact_lock(hashtextextended('pronto:protected-demo-bootstrap',0))");
    const existing = await db.query<{ count: number }>("select ((select count(*) from clients)+(select count(*) from users))::int as count");
    if (existing.rows[0].count !== 0) throw new Error("Bootstrap requires a new, empty protected-demo database. Existing accounts/data will not be overwritten.");
    await db.query(`insert into clients(id,name,slug,vertical,status,brand_voice,business_profile)
      values($1,'PS.Cafe Raffles City',$2,'fnb','pilot',$3,$4::jsonb)`,
      [DEMO_CLIENT_ID,DEMO_SLUG,"Unofficial demonstration voice: concise, courteous, honest about uncertainty.",
        JSON.stringify({ demoSeed: "ps-cafe-raffles-city-v1", timezone: "Asia/Singapore", approvedByRestaurant: false,
          chopeAvailability: { enabled: false }, reservationPolicy: { directBooking: false, liveAvailability: false } })]);
    for (const [index,account] of accounts.entries()) {
      await db.query("insert into users(id,client_id,email,name,role,password_hash) values($1,$2,$3,$4,$5,$6)",
        [account.id,account.role === "client" ? DEMO_CLIENT_ID : null,account.email.toLowerCase(),account.name,account.role,passwords[index]]);
      if (account.role === "client") for (const permission of staffCapabilities)
        await db.query("insert into staff_permission_grants(client_id,user_id,permission) values($1,$2,$3)",[DEMO_CLIENT_ID,account.id,permission]);
    }
    await db.query(`insert into agent_configs(client_id,prompt_preamble,retrieval_threshold)
      values($1,'Unofficial synthetic POC. Answer from the supplied public outlet facts only. Do not confirm bookings, prices or allergy suitability.',0.05)`,[DEMO_CLIENT_ID]);
    await db.query(`insert into channels(id,client_id,kind,name,status,settings)
      values($1,$2,'console','Simulated Instagram DM','active','{"transport":"customer_simulator"}'::jsonb)`,[DEMO_CHANNEL_ID,DEMO_CLIENT_ID]);
    for (const source of psCafeDemoSources) {
      const metadata = { demoSeed: true, sourceUrl: source.url, reviewStatus: source.reviewStatus,
        approvedByRestaurant: false, bootstrapFixture: true };
      await db.query(`insert into knowledge_sources(id,client_id,title,source_type,content,metadata)
        values($1,$2,$3,'curated_demo',$4,$5::jsonb)`,[source.id,DEMO_CLIENT_ID,source.title,source.content,JSON.stringify(metadata)]);
      for (const [index,chunk] of chunkText(source.content,{maxCharacters:900,overlap:120}).entries())
        await db.query(`insert into knowledge_chunks(source_id,client_id,chunk_index,content,token_estimate,embedding,embedding_model,embedding_dimensions,metadata)
          values($1,$2,$3,$4,$5,null,'none',0,$6::jsonb)`,
          [source.id,DEMO_CLIENT_ID,index,chunk.content,chunk.tokenEstimate,
            JSON.stringify({...metadata,retrievalMode:"local_text",retrievalProfile:LOCAL_TEXT_RETRIEVAL_PROFILE})]);
    }
    await recordAuditLog({clientId:DEMO_CLIENT_ID,actorUserId:accounts.find(a=>a.role==="operator")!.id,
      action:"demo.protected_bootstrapped",targetType:"client",targetId:DEMO_CLIENT_ID,
      metadata:{databaseId:settings.databaseId,sourceCount:psCafeDemoSources.length,syntheticOnly:true}},db);
  });
}

try {
  protectedDemoConfiguration();
  await assertCustomerDemoEnabled(); // Does not mark a database or relax test guards.
  const command=process.argv[2];
  if(command==="bootstrap" && process.argv[3]) await bootstrap(process.argv[3]);
  else if(command==="embed-gemini" && process.env.PRONTO_DEMO_REAL_AI_APPROVED==="1") await prepareRealDemoEmbeddings("gemini");
  else if(command!=="verify" && command!=="preflight") throw new Error("Use verify, bootstrap PRIVATE_JSON, embed-gemini, or preflight.");
  if(command==="preflight") {
    const settings=protectedDemoConfiguration();
    await assertSavedDemoWorkspaces(settings.allowedUserIds);
    await requireRealDemoConfiguration(true,profileForDemoChoice("groq-oss"));
  }
  console.log("Protected demo command completed; no credentials or conversation contents printed.");
} catch { console.error("Protected demo command failed. Check identity, private input, migrations and server-only configuration; no data was reset."); process.exitCode=1; }
finally { try { await getPool().end(); } catch { /* Configuration errors must not expose connection strings. */ } }
