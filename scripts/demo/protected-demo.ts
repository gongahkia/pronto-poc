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
import { hasOnlyProtectedDemoKnowledge } from "../../src/lib/knowledge/protected-demo";
import { demoInstagramConfiguration, isDemoInstagramChannel } from "../../src/lib/channels/instagram-demo";
import { isGuestEmail } from "../../src/lib/guest-policy";
import { chunkText } from "../../src/lib/knowledge/chunk";
import { recordAuditLog } from "../../src/lib/audit";
import { psCafeDemoSources } from "../demo/ps-cafe-raffles-city";

const accountSchema = z.object({ id: z.string().uuid(), email: z.string().email().regex(/\.(test|invalid)$/i),
  name: z.string().min(1).max(100), role: z.enum(["client","operator"]), password: z.string().min(16).max(256)
    .refine(value => new Set(value).size >= 12 && !/pronto-(ps-demo|operator|client)/i.test(value)) }).strict();

async function bootstrap(path: string) {
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
    const db=getPool(); const settings=protectedDemoConfiguration();
    const instagram=demoInstagramConfiguration();
    const tenant=await db.query<{safe:boolean}>(`select count(*)=1 and bool_and(id=$1 and slug=$2
      and business_profile->>'demoSeed'='ps-cafe-raffles-city-v1'
      and business_profile->>'approvedByRestaurant'='false') as safe from clients`,[DEMO_CLIENT_ID,DEMO_SLUG]);
    if(!tenant.rows[0]?.safe) throw new Error("Only the exact unofficial synthetic demo tenant may be present.");
    const unsafe=await db.query<{count:number}>(`select (
      (select count(*) from users where (role='client' and client_id is distinct from $1::uuid)
        or (role='operator' and client_id is not null) or email !~ '\\.(test|invalid)$')+
      (select count(*) from conversations where client_id<>$1 or
        ${instagram ? "customer_handle is null or not ((channel_id=$2 and customer_handle like 'demo:%') or (channel_id=$3 and external_thread_id=any($4::text[])))" : "channel_id<>$2 or customer_handle is null or customer_handle not like 'demo:%'"})
      )::int as count`,instagram?[DEMO_CLIENT_ID,DEMO_CHANNEL_ID,instagram.channelId,instagram.senderIds]:[DEMO_CLIENT_ID,DEMO_CHANNEL_ID]);
    if(unsafe.rows[0].count) throw new Error("Protected demo contains identities, conversations or knowledge outside its synthetic boundary.");
    if (!await hasOnlyProtectedDemoKnowledge())
      throw new Error("Protected demo knowledge must be curated fixtures or reviewed, published synthetic sources.");
    const users=await db.query<{id:string;email:string;role:string;client_id:string|null}>("select id,email,role,client_id from users");
    if(users.rows.some(user=>!(user.role==='client'&&user.client_id===DEMO_CLIENT_ID&&isGuestEmail(user.email))&&!settings.allowedUserIds.includes(user.id)) ||
      settings.allowedUserIds.some(id=>!users.rows.some(user=>user.id===id))) throw new Error("Demo account allowlist does not match persisted accounts.");
    const channels=await db.query<import('../../src/lib/types').Channel>("select id,client_id,kind,settings,external_id from channels where status='active'");
    if(channels.rows.length!==(instagram?2:1) || channels.rows.some(channel=>!(channel.id===DEMO_CHANNEL_ID&&channel.client_id===DEMO_CLIENT_ID&&
      channel.kind==='console'&&channel.settings.transport==='customer_simulator')&&!isDemoInstagramChannel(channel)))
      throw new Error("Only the console and explicitly approved Instagram test channel may be active.");
    const integrations=await db.query<{count:number}>("select count(*)::int as count from integration_credentials");
    if(integrations.rows[0].count) throw new Error("Protected POC must not contain external integration credentials.");
    await requireRealDemoConfiguration(true,profileForDemoChoice("groq-oss"));
  }
  console.log("Protected demo command completed; no credentials or conversation contents printed.");
} catch { console.error("Protected demo command failed. Check identity, private input, migrations and server-only configuration; no data was reset."); process.exitCode=1; }
finally { try { await getPool().end(); } catch { /* Configuration errors must not expose connection strings. */ } }
