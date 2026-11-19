import {demoBusinessScope} from "@/lib/demo-business";
import { query, type Queryable } from "@/lib/db";


// Administrative preflight accepts curated fixtures and synthetic sources that
// completed the existing review/publication workflow. Metadata alone is not
// publication evidence. Preflight checks the single-tenant boundary separately.
// Archived sources and live versions with pending edits retain their provenance.
export async function hasOnlyProtectedDemoKnowledge(db: Queryable = { query },clientId=demoBusinessScope().clientId): Promise<boolean> {
  const result = await db.query<{ safe: boolean }>(`select not exists (
    select 1 from knowledge_sources s where s.client_id = $1 and not coalesce((
      (s.source_type = 'curated_demo'
        and s.metadata @> '{"demoSeed":true,"approvedByRestaurant":false}'::jsonb)
      or (
        s.metadata @> '{"syntheticDemo":true,"approvedByRestaurant":false}'::jsonb
        and s.metadata->>'approvedAt' is not null
        and exists (select 1 from users u where u.client_id = s.client_id
          and u.role = 'client' and u.id::text = s.metadata->>'approvedBy')
        and exists (select 1 from knowledge_source_versions v
          where v.client_id = s.client_id and v.source_id = s.id
            and v.title = s.title and v.content = s.content and v.metadata = s.metadata)
        and (
          exists (select 1 from knowledge_source_submissions p
            join knowledge_source_submission_revisions r on r.client_id = p.client_id
              and r.submission_id = p.id and r.revision::text = s.metadata->>'submissionRevision'
            where p.client_id = s.client_id and p.target_source_id = s.id
              and p.id::text = s.metadata->>'submissionId'
              and p.published_at is not null
              and exists (select 1 from audit_logs a where a.client_id = s.client_id
                and a.action = 'knowledge_source.approved' and a.target_id = p.id
                and a.actor_user_id::text = s.metadata->>'approvedBy'
                and a.metadata->>'revision' = r.revision::text)
              and p.source_type = s.source_type and p.action = 'upsert'
              and r.title = s.title and r.content = s.content
              and r.content_sha256 = s.metadata->>'contentSha256')
          or exists (select 1 from knowledge_suggestions p
            join knowledge_suggestion_revisions r on r.client_id = p.client_id
              and r.suggestion_id = p.id and r.revision = p.current_revision
            where p.client_id = s.client_id and p.target_source_id = s.id
              and p.id::text = s.metadata->>'suggestionId'
              and p.current_revision::text = s.metadata->>'suggestionRevision'
              and p.status = 'published' and p.reviewed_revision = p.current_revision
              and p.reviewed_by::text = s.metadata->>'approvedBy'
              and s.source_type in ('client_manual', 'business_correction')
              and r.title = s.title and r.content = s.content)
        )
      )
    ), false)
  ) as safe`, [clientId]);
  return result.rows[0]?.safe === true;
}
