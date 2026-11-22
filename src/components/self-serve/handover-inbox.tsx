"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { HandoverSummary } from "@/lib/self-serve/handover-summary";
import { useWorkspace, Badge } from "./workspace";
import { formatDateTime } from "@/lib/date-format";

export function HandoverInbox() {
  const { canViewConversations } = useWorkspace();
  const [summary, setSummary] = useState<HandoverSummary | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!canViewConversations) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch("/api/client/handovers", { cache: "no-store" });
          if (!response.ok) throw new Error("Handover list unavailable.");
          const next: HandoverSummary = await response.json();
          if (!stopped) { setSummary(next); setError(false); }
        } catch { if (!stopped) setError(true); }
      }
      if (!stopped) timer = setTimeout(refresh, 10000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [canViewConversations]);
  if (!canViewConversations) return null;
  return <section className="ss-panel" aria-label="Conversations needing you">
    <div className="ss-row ss-wrap">
      <h2>Conversations needing you</h2>
      <Link className="ss-secondary" href="/client/conversations?status=needs_reply">View all</Link>
    </div>
    <p className="ss-muted">Review the reason here, then reply in the original messaging app.</p>
    {error && <p className="ss-feedback ss-error" role="alert">Could not refresh handovers. {summary ? "This list may be out of date." : "Try refreshing this page."}</p>}
    {!summary && !error && <p role="status">Loading handovers…</p>}
    {summary && <>
      {!summary.items.length && <p className="ss-muted">No conversations currently need your attention.</p>}
      <ul className="ss-handover-queue">
        {summary.items.map(item => <li key={item.id}>
          <div className="ss-row ss-wrap">
            <strong>{item.customer}</strong>
            <Badge tone="amber">{item.paused ? "AI paused" : "Needs review"}</Badge>
          </div>
          <p>{item.reason}</p>
          <p className="ss-muted">{item.handle ? `${item.handle} · ` : ""}{item.channel} · {formatDateTime(item.updatedAt)}</p>
          <div className="ss-actions">
            <Link className="ss-secondary" href={`/client/conversations/${item.id}`}>Review conversation</Link>
            {item.channel === "instagram" && <a className="ss-link" href="https://www.instagram.com/direct/inbox/" target="_blank" rel="noopener noreferrer">Open Instagram inbox</a>}
          </div>
        </li>)}
      </ul>
      {summary.hasMore && <p className="ss-muted">More conversations need attention. Open View all to see the full list.</p>}
    </>}
  </section>;
}
