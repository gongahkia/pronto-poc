import {demoBusinessScope} from "@/lib/demo-business";
import { query, transaction, vectorLiteral } from "@/lib/db";
import { assertCustomerDemoEnabled, DemoError } from "@/lib/customer-demo-boundary";
import { requireRealDemoConfiguration } from "@/lib/customer-demo-ai";
import { getEmbeddingProvider } from "@/lib/llm";
import { withAiExecutionMode } from "@/lib/llm/execution-mode";
import { recordAuditLog } from "@/lib/audit";
import { createHash } from "node:crypto";
import { withAiExecutionProfile } from "@/lib/llm/execution-mode";
import { profileForDemoChoice } from "@/lib/customer-demo-ai";
import { GEMINI_EMBEDDING_PROFILE } from "@/lib/llm/demo-models";

export async function setupCustomerSimulator() {
  await assertCustomerDemoEnabled();
  await transaction(async db => {
    const client = await db.query<{ id: string }>(`select id from clients where id=$1 and slug=$2
      and business_profile->>'demoSeed'=$3 for update`, [demoBusinessScope().clientId, demoBusinessScope().slug,demoBusinessScope().seed]);
    if (!client.rows[0]) throw new DemoError("Prepare the selected demo business first.");
    const channel = await db.query<{ client_id: string; kind: string; settings: Record<string, unknown> }>(
      "select client_id,kind,settings from channels where id=$1", [demoBusinessScope().channelId]);
    if (channel.rows[0] && (channel.rows[0].client_id !== demoBusinessScope().clientId || channel.rows[0].kind !== "console" ||
        channel.rows[0].settings.transport !== "customer_simulator")) throw new DemoError("Simulator channel identity is occupied.");
    await db.query(`insert into channels (id,client_id,kind,name,status,settings)
      values ($1,$2,'console','Simulated Instagram DM','active','{"transport":"customer_simulator"}'::jsonb)
      on conflict (id) do nothing`, [demoBusinessScope().channelId, demoBusinessScope().clientId]);
    await recordAuditLog({ clientId: demoBusinessScope().clientId, actorUserId: null, action: "demo.simulator_prepared", targetType: "channel", targetId: demoBusinessScope().channelId }, db);
  });
}

export async function prepareRealDemoEmbeddings(provider?: "gemini") {
  await assertCustomerDemoEnabled();
  const config = await requireRealDemoConfiguration(false, provider === "gemini" ? profileForDemoChoice("gemini-flash") : undefined);
  const chunks = await query<{ id: string; content: string; source_id: string }>(`select k.id,k.content,k.source_id
    from knowledge_chunks k join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
    where k.client_id=$1 and coalesce(s.metadata->>'archived','false')<>'true' order by k.id`, [demoBusinessScope().clientId]);
  if (!chunks.rows.length) throw new DemoError("No published demo knowledge chunks exist.");
  const embed = () => getEmbeddingProvider(config.embeddingProvider)
    .embed(chunks.rows.map(row => row.content), config.embeddingModel, { clientId: demoBusinessScope().clientId, operation: "embedding", embeddingTask: "document" });
  const vectors = config.embeddingProvider === "gemini"
    ? await withAiExecutionProfile({ mode: "real", syntheticDemo: true }, embed)
    : await withAiExecutionMode("real", embed);
  if (vectors.length !== chunks.rows.length || vectors.some(vector => ![1536, 3072].includes(vector.length) || vector.some(value => !Number.isFinite(value))))
    throw new DemoError("Provider returned invalid embedding dimensions.");
  await transaction(async db => {
    for (const [index, chunk] of chunks.rows.entries()) {
      if (config.embeddingProvider === "gemini") {
        if (vectors[index].length !== 1536) throw new DemoError("Gemini embedding dimensions do not match the demo profile.");
        const inserted = await db.query(`insert into customer_demo_embeddings
          (chunk_id,client_id,profile,content_hash,embedding)
          select k.id,k.client_id,$4,$5,$6::vector from knowledge_chunks k
          join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
          where k.id=$1 and k.client_id=$2 and k.content=$3 and coalesce(s.metadata->>'archived','false')<>'true'
          on conflict(chunk_id) do update set embedding=excluded.embedding,content_hash=excluded.content_hash,
            profile=excluded.profile,prepared_at=now() returning chunk_id`,
          [chunk.id, demoBusinessScope().clientId, chunk.content, GEMINI_EMBEDDING_PROFILE,
            createHash("sha256").update(chunk.content).digest("hex"), vectorLiteral(vectors[index])]);
        if (!inserted.rowCount) throw new DemoError("Published knowledge changed during embedding preparation. Retry against the current revision.");
        continue;
      }
      const updated = await db.query(`update knowledge_chunks k set embedding=$4::vector, embedding_model=$5,
        embedding_dimensions=$6, metadata=k.metadata || jsonb_build_object('embeddingProvider',$7::text)
        where k.id=$1 and k.client_id=$2 and k.content=$3 and exists(select 1 from knowledge_sources s
          where s.id=k.source_id and s.client_id=$2 and coalesce(s.metadata->>'archived','false')<>'true') returning k.id`,
        [chunk.id, demoBusinessScope().clientId, chunk.content, vectorLiteral(vectors[index]), config.embeddingModel, vectors[index].length, config.embeddingProvider]);
      if (!updated.rowCount) throw new DemoError("Published knowledge changed during embedding preparation. Retry against the current revision.");
    }
    await recordAuditLog({ clientId: demoBusinessScope().clientId, actorUserId: null, action: "demo.real_embeddings_prepared",
      targetType: "knowledge", metadata: { provider: config.embeddingProvider, model: config.embeddingModel, count: vectors.length } }, db);
  });
  return { provider: config.embeddingProvider, model: config.embeddingModel, count: vectors.length };
}
