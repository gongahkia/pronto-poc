import { query, vectorLiteral } from "@/lib/db";
import { logInfo } from "@/lib/logger";
import type { KnowledgeChunk } from "@/lib/types";
import { GEMINI_EMBEDDING_PROFILE, LOCAL_TEXT_RETRIEVAL_PROFILE } from "@/lib/llm/demo-models";

// Live chunks are populated by publication, never pending submissions/drafts.
// This POC additionally requires retained business-review evidence, or its
// explicitly curated public demo facts. Flagged/archived material is withheld.
const approvedTextSource = `coalesce(s.metadata->>'archived','false')<>'true'
  and coalesce(s.metadata->>'reviewStatus','') not ilike '%conflict%'
  and ((s.metadata->>'approvedBy' is not null and s.metadata->>'approvedAt' is not null)
    or (s.client_id='00000000-0000-4000-8000-00000000a101'::uuid
      and s.source_type='curated_demo' and s.metadata->>'demoSeed'='true'
      and s.metadata->>'reviewStatus' in ('public_fact','public_fact_with_dietary_caution')))`;

export async function hasApprovedTextKnowledge(clientId: string): Promise<boolean> {
  const result = await query<{ ready: boolean }>(`select exists(select 1 from knowledge_chunks k
    join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
    where k.client_id=$1 and ${approvedTextSource}) as ready`, [clientId]);
  return result.rows[0]?.ready === true;
}

export async function retrieveKnowledgeText(clientId: string, searchQuery: string, limit = 5,
  options: { requestId?: string; conversationId?: string } = {}): Promise<KnowledgeChunk[]> {
  if (!searchQuery.trim()) return [];
  const boundedLimit = Math.max(1, Math.min(20, limit));
  const result = await query<KnowledgeChunk & { keyword_rank: number }>(`with search as (
      select websearch_to_tsquery('simple',$2) as query
    ) select k.id,k.source_id,k.client_id,k.chunk_index,k.content,k.token_estimate,
      (k.metadata - 'embeddingProvider') || jsonb_build_object('retrievalMode','local_text','retrievalProfile',$4::text,
        'sourceTitle',s.title,'sourceUrl',coalesce(s.metadata->>'sourceUrl',s.metadata->>'sourceReference'),
        'sourceVersion',v.version_number,'sourceContentHash',encode(sha256(convert_to(s.content,'UTF8')),'hex'),
        'approvalEvidence',case when s.metadata->>'approvedBy' is not null then 'business_review'
          else 'curated_public_demo_fact' end) as metadata,
      ts_rank_cd(to_tsvector('simple',s.title || E'\\n' || k.content),search.query) as keyword_rank
    from knowledge_chunks k join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
    left join lateral (select version_number from knowledge_source_versions
      where source_id=s.id and client_id=s.client_id and content=s.content order by version_number desc limit 1) v on true,
    search where k.client_id=$1 and ${approvedTextSource}
      and to_tsvector('simple',s.title || E'\\n' || k.content) @@ search.query
    order by keyword_rank desc,k.id limit $3`, [clientId,searchQuery,boundedLimit*4,LOCAL_TEXT_RETRIEVAL_PROFILE]);
  const chunks = dedupeChunks(result.rows.map(row => ({ ...row,
    score: Math.min(Number(row.keyword_rank) * 8, 1) })), boundedLimit);
  logInfo("knowledge.retrieval_completed", { clientId, ...options, mode: "local_text",
    retrievalProfile: LOCAL_TEXT_RETRIEVAL_PROFILE, resultCount: chunks.length,
    embeddingDimensions: 0, embeddingModel: null, topScore: chunks[0]?.score ?? null });
  return chunks;
}

export async function retrieveKnowledge(
  clientId: string,
  embedding: number[],
  limit = 5,
  options: {
    requestId?: string;
    conversationId?: string;
    queryText?: string | null;
    embeddingModel?: string | null;
    embeddingProvider?: string;
    excludeSourceIds?: string[];
  } = {},
): Promise<KnowledgeChunk[]> {
  const searchQuery = options.queryText?.trim();
  const candidateLimit = Math.max(limit * 4, 20);
  const embeddingDimensions = embedding.length;
  if (options.embeddingProvider === "gemini" && embeddingDimensions !== 1536)
    throw new Error("The Gemini demo retrieval profile requires 1536 dimensions.");
  // Same hybrid retrieval and tenant predicates; a separate index preserves all
  // existing vectors. Content hashes invalidate embeddings after publication edits.
  const chunkRelation = options.embeddingProvider === "gemini" ? `(select k.id,k.source_id,k.client_id,
    k.chunk_index,k.content,k.token_estimate,e.model as embedding_model,1536 as embedding_dimensions,
    k.metadata || jsonb_build_object('embeddingProvider','gemini') as metadata,e.embedding
    from knowledge_chunks k join customer_demo_embeddings e on e.chunk_id=k.id and e.client_id=k.client_id
    join knowledge_sources s on s.id=k.source_id and s.client_id=k.client_id
    where k.client_id=$1 and e.profile='${GEMINI_EMBEDDING_PROFILE}'
      and e.content_hash=encode(sha256(convert_to(k.content,'UTF8')),'hex')
      and coalesce(s.metadata->>'archived','false')<>'true')` : "knowledge_chunks";
  const vectorDistance = vectorDistanceExpression(embeddingDimensions);
  const excluded = options.excludeSourceIds ?? [];
  const providerIndex = (searchQuery ? 8 : 6) + (excluded.length ? 1 : 0);
  const providerFilter = (alias = "") => options.embeddingProvider
    ? `and ${alias}metadata->>'embeddingProvider' = $${providerIndex}` : "";
  const result = searchQuery
    ? await query<KnowledgeChunk & {
        distance: string;
        vector_score: string;
        keyword_rank: string;
        combined_score: string;
      }>(
        `
          with fts_query as (
            select websearch_to_tsquery('simple', $3) as query
          ),
          vector_scored as materialized (
            select
              id,
              source_id,
              client_id,
              chunk_index,
              content,
              token_estimate,
              embedding_model,
              embedding_dimensions,
              metadata,
              ${vectorDistance} as distance
            from ${chunkRelation} kc
            where client_id = $1
              and embedding is not null
              and embedding_dimensions = $6
              and ($7::text is null or embedding_model = $7)
              ${providerFilter()}
              ${excluded.length ? "and source_id <> all($8::uuid[])" : ""}
            order by ${vectorDistance}
            limit $4
          ),
          keyword_scored as materialized (
            select
              kc.id,
              kc.source_id,
              kc.client_id,
              kc.chunk_index,
              kc.content,
              kc.token_estimate,
              kc.embedding_model,
              kc.embedding_dimensions,
              kc.metadata,
              ${vectorDistance.split("embedding").join("kc.embedding")} as distance
            from ${chunkRelation} kc, fts_query
            where kc.client_id = $1
              and kc.embedding is not null
              and kc.embedding_dimensions = $6
              and ($7::text is null or kc.embedding_model = $7)
              ${providerFilter("kc.")}
              ${excluded.length ? "and kc.source_id <> all($8::uuid[])" : ""}
              and to_tsvector('simple', kc.content) @@ fts_query.query
            order by ts_rank_cd(to_tsvector('simple', kc.content), fts_query.query) desc
            limit $4
          ),
          combined as (
            select * from vector_scored
            union
            select * from keyword_scored
          )
          select
            combined.*,
            (1 - combined.distance)::text as vector_score,
            ts_rank_cd(to_tsvector('simple', combined.content), fts_query.query)::text as keyword_rank,
            (
              least(
                (1 - combined.distance) +
                least(ts_rank_cd(to_tsvector('simple', combined.content), fts_query.query) * 8, 0.75),
                1
              )
            )::text as combined_score
          from combined, fts_query
          order by
            (
              least(
                (1 - combined.distance) +
                least(ts_rank_cd(to_tsvector('simple', combined.content), fts_query.query) * 8, 0.75),
                1
              )
            ) desc,
            combined.distance asc
          limit $5
        `,
        [
          clientId,
          vectorLiteral(embedding),
          searchQuery,
          candidateLimit,
          candidateLimit,
          embeddingDimensions,
          options.embeddingModel ?? null,
          ...(excluded.length ? [excluded] : []),
          ...(options.embeddingProvider ? [options.embeddingProvider] : []),
        ],
      )
    : await query<KnowledgeChunk & { distance: string }>(
        `
          with scored as materialized (
            select
              id,
              source_id,
              client_id,
              chunk_index,
              content,
              token_estimate,
              embedding_model,
              embedding_dimensions,
              metadata,
              ${vectorDistance} as distance
            from ${chunkRelation} kc
            where client_id = $1
              and embedding is not null
              and embedding_dimensions = $4
              and ($5::text is null or embedding_model = $5)
              ${providerFilter()}
              ${excluded.length ? "and source_id <> all($6::uuid[])" : ""}
          )
          select * from scored
          order by distance
          limit $3
        `,
        [
          clientId,
          vectorLiteral(embedding),
          candidateLimit,
          embeddingDimensions,
          options.embeddingModel ?? null,
          ...(excluded.length ? [excluded] : []),
          ...(options.embeddingProvider ? [options.embeddingProvider] : []),
        ],
      );

  const chunks = dedupeChunks(
    result.rows.map((row) => ({
    ...row,
    score:
      "combined_score" in row
        ? Math.min(Number(row.combined_score), 1)
        : 1 - Number(row.distance),
    })),
    limit,
  );

  logInfo("knowledge.retrieval_completed", {
    requestId: options.requestId,
    clientId,
    conversationId: options.conversationId,
    limit,
    mode: searchQuery ? "hybrid" : "vector",
    resultCount: chunks.length,
    candidateCount: result.rows.length,
    embeddingDimensions,
    embeddingModel: options.embeddingModel ?? null,
    topScore: chunks[0]?.score ?? null,
    topKeywordRank:
      searchQuery && result.rows[0] && "keyword_rank" in result.rows[0]
        ? Number(result.rows[0].keyword_rank)
        : null,
  });

  return chunks;
}

function vectorDistanceExpression(dimensions: number): string {
  if (dimensions === 1536) {
    return "(embedding::vector(1536) <=> $2::vector(1536))";
  }
  if (dimensions === 3072) {
    return "(embedding::halfvec(3072) <=> $2::halfvec(3072))";
  }
  return "(embedding <=> $2::vector)";
}

function dedupeChunks<T extends KnowledgeChunk>(chunks: T[], limit: number): T[] {
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const fingerprint = normalizedContent(chunk.content);
    if (seen.has(fingerprint)) continue;
    if (
      selected.some(
        (existing) => jaccardSimilarity(contentTokens(existing.content), contentTokens(chunk.content)) > 0.82,
      )
    ) {
      continue;
    }
    selected.push(chunk);
    seen.add(fingerprint);
    if (selected.length >= limit) break;
  }
  return selected;
}

function normalizedContent(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function contentTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}
