import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getClient } from "@/lib/dashboard";
import { hasStaffCapability } from "@/lib/staff-permissions";
import { listSourceSubmissions } from "@/lib/knowledge/submissions";
import { listKnowledgeSuggestions } from "@/lib/knowledge/suggestions";
import { listKnowledgeReviewItems } from "@/lib/knowledge/review-items";
import { getKnowledgeSourceForClient } from "@/lib/knowledge/manage";
import { KnowledgeReviewDetail, type KnowledgeReviewEntry } from "@/components/knowledge-review-detail";
import { AppShell } from "@/components/shell";

export default async function KnowledgeReviewPage({ params }: { params: Promise<{ kind: string; reviewId: string }> }) {
  const user = await requireUser("client");
  if (!user.clientId) notFound();
  const { kind, reviewId } = await params;
  if (!z.string().uuid().safeParse(reviewId).success || !["submission", "suggestion", "question"].includes(kind)) notFound();
  let review: KnowledgeReviewEntry;
  if (kind === "submission") {
    const [item] = await listSourceSubmissions(user.clientId, reviewId); if (!item) notFound(); review = { kind, item };
  } else if (kind === "suggestion") {
    const [item] = await listKnowledgeSuggestions(user.clientId, reviewId); if (!item) notFound(); review = { kind, item };
  } else {
    const [item] = await listKnowledgeReviewItems(user.clientId, reviewId); if (!item) notFound(); review = { kind: "question", item };
  }
  const [client, source, canApprove] = await Promise.all([
    getClient(user.clientId), review.kind === "question" ? null : getKnowledgeSourceForClient(review.item.target_source_id, user.clientId),
    hasStaffCapability(user, user.clientId, "knowledge.approve"),
  ]);
  if (!client) notFound();
  return <AppShell user={user} active="client" clientActive="knowledge" workspaceName={client.name} workspaceProfile={client.business_profile}>
    <div className="mb-5 flex items-center gap-3"><Link href="/client/knowledge" aria-label="Back to knowledge" title="Back to knowledge"
      className="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground"><ArrowLeft size={20} aria-hidden="true"/></Link>
      <div className="min-w-0"><h1 className="text-xl font-semibold">{review.kind === "question" ? "Improve an answer" : review.item.title}</h1>
        <p className="mt-1 text-sm text-muted">Review information before it reaches customer answers.</p></div></div>
    <KnowledgeReviewDetail review={review} source={source} user={user} canApprove={canApprove}/>
  </AppShell>;
}
