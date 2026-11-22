"use client";
import { useEffect, useState } from "react";
import { api, Badge, useWorkspace } from "./workspace";
import { scenarios, type PresetId } from "@/lib/self-serve/catalog";

export function ModelVoicePreview({ presetId, notes }: { presetId?: PresetId; notes?: string[] }) {
  const { state, busy, run } = useWorkspace();
  const [jobId, setJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ question: string; reply: string; model: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await api<{ status: string; model: string | null; error: string | null;
          result: { question: string; reply: string } | null }>("/jobs/" + jobId);
        if (stopped) return;
        if (job.status === "ready") {
          if (!job.model || !job.result?.reply || !job.result.question)
            throw new Error("The preview could not be verified. Generate it again.");
          setPreview({ ...job.result, model: job.model }); setJobId(null); return;
        }
        if (["failed", "cancelled"].includes(job.status)) throw new Error(job.error || "Preview stopped. Try again.");
      } catch (failure) {
        if (!stopped) { setError(failure instanceof Error ? failure.message : "Preview unavailable."); setJobId(null); }
        return;
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobId]);
  return <div className="ss-preview-result">
    <p className="ss-muted">Fictional customer enquiry</p>
    <p className="ss-bubble ss-customer">{preview?.question ?? scenarios[state.settings!.industry].preview}</p>
    {preview && <><Badge>AI preview · {preview.model}</Badge><p className="ss-bubble ss-business">{preview.reply}</p></>}
    {!preview && !jobId && !error && <p className="ss-muted">Generate a reply to try this voice.</p>}
    {jobId && <p role="status">Generating a reply with the configured AI model… Keep this page open.</p>}
    {error && <p className="ss-feedback ss-error" role="alert">{error}</p>}
    <div className="ss-actions"><button className="ss-secondary" disabled={busy || !!jobId}
      onClick={async () => {
        setPreview(null); setError("");
        const result = await run(() => api<{ id: string }>("/preview", "POST", {
          id: crypto.randomUUID(), ...(presetId ? { preset_id: presetId } : { notes }),
        }), "AI preview queued.");
        if (result) setJobId(result.id);
      }}>{preview ? "Generate another reply" : "Generate AI preview"}</button></div>
    <p className="ss-muted">Style demonstration only. No booking or other action is performed. Generating a preview does not change your active voice.</p>
  </div>;
}
