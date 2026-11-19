import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAssistantDraft } from "@/lib/assistant-drafts";
import { getClient } from "@/lib/dashboard";
import { getKnowledgeSourceForClient, getKnowledgeSourceVersionsForClient } from "@/lib/knowledge/manage";
import { listSourceSubmissions } from "@/lib/knowledge/submissions";
import { listKnowledgeSuggestions } from "@/lib/knowledge/suggestions";
import { listKnowledgeReviewItems } from "@/lib/knowledge/review-items";
import { reviewStatusLabel, safeSourceUrl } from "@/lib/knowledge/review-display";
import { AppShell } from "@/components/shell";
import { Badge } from "@/components/badge";
import { KnowledgeActions } from "@/components/knowledge-actions";
import { KnowledgeConflictReview, KnowledgeDiff } from "@/components/knowledge-diff";
import { KnowledgeForm } from "@/components/knowledge-form";
import { KnowledgeSourceDiagnostics, KnowledgeSourceVersionHistory } from "@/components/knowledge-source-panels";

export default async function ClientKnowledgeSourcePage({ params, searchParams }: {
  params: Promise<{ sourceId: string }>; searchParams?: Promise<{ submitted?: string }>;
}) {
  const user = await requireUser("client");
  if (!user.clientId) notFound();
  const { sourceId } = await params;
  const [client, source, versions, draft, submissions, suggestions, questions, search] = await Promise.all([
    getClient(user.clientId), getKnowledgeSourceForClient(sourceId, user.clientId),
    getKnowledgeSourceVersionsForClient(sourceId, user.clientId), getAssistantDraft(user.clientId),
    listSourceSubmissions(user.clientId), listKnowledgeSuggestions(user.clientId), listKnowledgeReviewItems(user.clientId),
    searchParams ?? Promise.resolve({} as { submitted?: string }),
  ]);
  const change = draft?.knowledge_changes[sourceId];
  if (!client || (!source && !change)) notFound();
  const title = source?.title ?? change?.title ?? "Knowledge source";
  const content = source?.content ?? "";
  const conflict = String(source?.metadata.reviewStatus ?? "").includes("conflict");
  const pending = [
    ...submissions.filter(item => item.target_source_id === sourceId && item.status !== "published").map(item => ({ id: item.id, kind: "submission", title: item.title, status: item.status })),
    ...suggestions.filter(item => item.target_source_id === sourceId && item.status !== "published").map(item => ({ id: item.id, kind: "suggestion", title: item.title, status: item.status })),
    ...questions.filter(item => item.status === "open" && item.source_references.some(ref => ref.sourceId === sourceId)).map(item => ({ id: item.id, kind: "question", title: item.question, status: "open" })),
  ];
  const reference = safeSourceUrl(source?.metadata.sourceUrl ?? source?.metadata.sourceReference);
  return <AppShell user={user} active="client" clientActive="knowledge" workspaceName={client.name} workspaceProfile={client.business_profile}>
    <div className="mb-5 flex items-center gap-3"><Link href="/client/knowledge" aria-label="Back to knowledge" title="Back to knowledge"
      className="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground"><ArrowLeft size={20} aria-hidden="true"/></Link>
      <div className="min-w-0"><h1 className="text-xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted">Source information and proposed updates.</p></div></div>
    {search.submitted && <p role="status" className="mb-5 rounded-md bg-success-bg p-3 text-sm text-success">Revision submitted for review. Customer answers have not changed.</p>}
    <div className="space-y-5">
      {source && <KnowledgeConflictReview metadata={source.metadata}/>}
      {pending.length > 0 && <section className="ui-panel overflow-hidden"><div className="border-b border-line p-5"><h2 className="font-semibold">Proposed updates</h2><p className="mt-1 text-sm text-muted">Open an update to compare the text and review its revision.</p></div>
        <ul className="divide-y divide-line">{pending.map(item => <li key={`${item.kind}:${item.id}`}><Link href={`/client/knowledge/reviews/${item.kind}/${item.id}`} className="flex items-center gap-3 p-5 hover:bg-surface-hover">
          <span className="min-w-0 flex-1 text-sm font-medium">{item.title}</span><Badge tone={item.status === "rejected" || item.status === "validation_failed" ? "red" : "amber"}>{reviewStatusLabel(item.status)}</Badge><ArrowRight size={16} className="shrink-0 text-muted" aria-hidden="true"/></Link></li>)}</ul>
      </section>}
      {change && <section className="ui-panel p-5"><h2 className="mb-4 font-semibold">Prepared draft</h2><KnowledgeDiff before={content} after={change.action === "delete" ? "" : change.content ?? ""}/></section>}
      <section className="ui-panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5"><div><div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">Source content</h2>
          <Badge tone={conflict || !source ? "amber" : "green"}>{conflict ? "Needs review" : source ? "Published" : "Unpublished draft"}</Badge></div>
          {source?.current_version && <p className="mt-2 text-xs text-muted">Version {source.current_version}</p>}
          {reference && <a href={reference} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-accent">{reference}</a>}
          {typeof source?.metadata.filename === "string" && <p className="mt-2 text-xs text-muted">{source.metadata.filename}</p>}</div>
          <KnowledgeActions sources={[{ id: sourceId, title }]} defaultSourceId={sourceId} outletName={String(client.business_profile.outletName ?? "")} requestKey={randomUUID()} onlyCorrection/>
        </div>
        <div className="whitespace-pre-wrap break-words p-5 text-sm leading-7 [overflow-wrap:anywhere]">{content || change?.content}</div>
        {source && <details className="border-t border-line"><summary className="cursor-pointer px-5 py-4 text-sm font-medium">Propose a source revision</summary>
          <div className="space-y-5 px-5 pb-5"><KnowledgeForm action={`/api/client/knowledge/${sourceId}`} submitLabel="Submit revised source for review">
            <input type="hidden" name="action" value="update"/>
            <label className="text-sm font-medium">Title<input name="title" required defaultValue={title} className="ui-input mt-1 block w-full px-3 py-2 font-normal"/></label>
            <label className="text-sm font-medium">Source content<textarea name="content" required rows={12} defaultValue={content} className="ui-input mt-1 block w-full px-3 py-2 font-normal"/></label>
          </KnowledgeForm>
          <KnowledgeForm action={`/api/client/knowledge/${sourceId}`} className="border-t border-line pt-4"><input type="hidden" name="action" value="delete"/><button className="text-sm text-danger">Propose source archive</button></KnowledgeForm></div>
        </details>}
        {source && <details className="border-t border-line text-sm"><summary className="cursor-pointer px-5 py-4 font-medium">Version history and import details</summary>
          <KnowledgeSourceDiagnostics metadata={source.metadata}/><KnowledgeSourceVersionHistory currentVersion={source.current_version ? Number(source.current_version) : null} versions={versions}/>
        </details>}
      </section>
    </div>
  </AppShell>;
}
