"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Send, RefreshCw, MessageCircle } from "lucide-react";
import { PsCafeLogo } from "@/components/ps-cafe-logo";
import { MessageText } from "@/components/message-text";
import { DEFAULT_DEMO_MODEL, demoModelChoices, type DemoModelChoice, type DemoAiProfile } from "@/lib/llm/demo-models";
import {DEMO_MESSAGE_QUEUED} from '@/components/demo-queue-pump';

const customerModelChoices = demoModelChoices.filter(option => option.id !== "mock" && option.id !== "configured");

type State = {
  now: string;
  sessions: { id: string; conversation_id: string; ai_mode: "real" | "mock"; ai_selection: string; ai_configuration: DemoAiProfile | null; created_at: string }[];
  modelChoices: { id: string; available: boolean; detail: string }[];
  realAi: { available: boolean; detail: string; provider?: string; model?: string };
  session: { id: string; conversation_id: string; ai_mode: "real" | "mock"; ai_selection: string; ai_configuration: DemoAiProfile | null; status: string; staff_review_pending?:boolean } | null;
  messages: { id: string; body: string; sender: string; created_at: string; generation_mode: string | null;
    response_provider: string | null; response_model: string | null }[];
  job: { status: string; created_at: string; delivery_status?: string | null; available_at?: string; busy?:boolean; failure_code?: string; failure_provider?: string } | null;
  providerError: boolean;
  providerFailureCode: string | null;
};

async function demoRequest(path: string, body?: unknown) {
  const response = await fetch(path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The request failed. Please try again.");
  return data;
}

export function CustomerSimulator() {
  const [state, setState] = useState<State | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [choice, setChoice] = useState<DemoModelChoice>(DEFAULT_DEMO_MODEL);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const retry = useRef<{ text: string; requestId: string; sessionId: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const polling = useRef(false);
  const load = useCallback(async () => {
    // Slow cloud responses must finish before the next poll. Otherwise every
    // response can be superseded before it is displayed on a small instance.
    if(polling.current)return;
    polling.current=true;
    const version = ++requestVersion.current;
    try {
      const value = await demoRequest(`/api/demo/customer${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
      if (version === requestVersion.current) setState(value);
    } catch (failure) {
      if (version === requestVersion.current) setError(failure instanceof Error ? failure.message : "Could not load the conversation.");
    }finally{polling.current=false;}
  }, [sessionId]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2500);
    return () => { window.clearInterval(timer); window.clearTimeout(initial); };
  }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [state?.messages.length]);
  const start = async () => {
    if (loading || sending || !state?.modelChoices.find(option => option.id === choice)?.available) return;
    setLoading(true); setError("");
    try {
      const session = await demoRequest("/api/demo/customer", { action: "create", mode: "real", choice });
      ++requestVersion.current;
      retry.current = null; setText(""); setSessionId(session.id); setState(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not start a conversation."); }
    finally { setLoading(false); }
  };
  const send = async () => {
    if (!sessionId || state?.session?.id !== sessionId || !text.trim() || loading || sending) return;
    const pending = retry.current && retry.current.sessionId === sessionId && retry.current.text === text.trim()
      ? retry.current : { text: text.trim(), requestId: crypto.randomUUID(), sessionId };
    retry.current = pending; setSending(true); setError("");
    try {
      await demoRequest("/api/demo/customer", { action: "send", ...pending });
      window.setTimeout(() => window.dispatchEvent(new Event(DEMO_MESSAGE_QUEUED)), 3200);
      retry.current = null; setText(""); await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Send failed. Retry uses the same message ID."); }
    finally { setSending(false); }
  };
  const retryProcessing = async () => {
    setSending(true); setError("");
    try { await demoRequest("/api/demo/customer", { action: "retry", sessionId }); window.dispatchEvent(new Event(DEMO_MESSAGE_QUEUED));await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Retry failed."); }
    finally { setSending(false); }
  };
  const processing = state?.job && ["pending", "processing", "failed"].includes(state.job.status);
  const deliveryPending = state?.job?.status === "completed" && ["pending", "sending","failed"].includes(state.job.delivery_status ?? "");
  const delayed = processing && Date.parse(state!.now) - Date.parse(state!.job!.created_at) > 120_000;
  const humanOwned = state?.session && state.session.status !== "active";
  const availability = state?.modelChoices?.find(option => option.id === choice);
  return <main className="min-h-screen bg-surface px-3 py-5 text-foreground sm:px-6">
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-accent">Pronto</p>
          <h1 className="text-xl font-semibold">Messages</h1></div>
      </header>
      <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="ui-panel min-w-0 space-y-4 p-4">
          <button className="ui-primary-button w-full px-3 py-2 text-sm" disabled={loading || sending || !availability?.available} onClick={() => void start()}>{loading ? "Starting…" : "New conversation"}</button>
          <details className="space-y-3 text-sm">
            <summary className="cursor-pointer font-medium">Model settings</summary>
            <label className="block text-sm font-medium">AI model
              <select aria-label="AI model" className="ui-input mt-2 w-full px-3 py-2" disabled={loading || sending}
                value={availability?.available ? choice : ""} onChange={event => setChoice(event.target.value as DemoModelChoice)}>
                <option value="" disabled>{state ? "Choose an available model" : "Checking models…"}</option>
                {customerModelChoices.filter(option => option.id !== "openai-local" ||
                  state?.modelChoices.some(item => item.id === option.id)).map(option => {
                  const configuration = state?.modelChoices.find(item => item.id === option.id);
                  return <option key={option.id} value={option.id} disabled={!configuration?.available}
                    className="disabled:text-muted" title={configuration?.detail}>
                    {option.label}{configuration?.available ? "" : " — unavailable"}
                  </option>;
                })}
              </select>
            </label>
            {availability && <div className="rounded-md border border-line p-3 text-xs">
              <strong>{availability.available ? "Available" : "Unavailable"}</strong>
              <p className="mt-1 break-words text-muted">{availability.detail}</p>
            </div>}
            {state?.providerFailureCode === "quota_exhausted" && <p className="text-xs text-danger">The selected provider’s quota is exhausted. Choose another available model and start a new conversation.</p>}
          </details>
          <nav aria-label="Your conversations"><p className="mb-2 text-xs font-semibold text-muted">Your conversation history</p>
            <div className="flex gap-2 overflow-x-auto md:block md:max-h-[36rem] md:overflow-y-auto">
            {state?.sessions.map((session, index) => <button key={session.id} disabled={loading || sending} className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-2 text-left text-sm md:mb-2 md:block md:w-full ${sessionId === session.id ? "border-accent bg-accent-soft" : "border-line"}`}
              onClick={() => { ++requestVersion.current; retry.current = null; setText(""); setState(null); setSessionId(session.id); }}>
              Conversation {state.sessions.length - index}</button>)}
            </div>
          </nav>
        </aside>
        <section aria-label="Customer chat" className="ui-panel flex min-h-[34rem] min-w-0 flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-4 py-4">
            <ArrowLeft size={19} aria-hidden="true"/><PsCafeLogo className="h-11 w-20"/>
            <div className="min-w-0"><h2 className="font-semibold">PS.Cafe Raffles City</h2><p className="text-xs text-muted">Restaurant enquiries</p></div>
          </div>
          <div className="max-h-[32rem] flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" aria-label="Message history">
            {!state?.session ? <div className="mx-auto mt-16 max-w-xs text-center text-sm text-muted"><MessageCircle className="mx-auto mb-3"/>
              Start a conversation with PS.Cafe Raffles City, or continue a previous conversation.</div> : null}
            {state?.messages.map(message => <div key={message.id} className={`flex ${message.sender === "customer" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm ${message.sender === "customer" ? "bg-accent text-white" : "border border-line bg-surface"}`}>
                <p className="mb-1 text-xs opacity-75">{message.sender === "customer" ? "You" : message.sender === "human" ? "Our team" : "PS.Cafe assistant"}</p>
                <p className="whitespace-pre-wrap break-words leading-6"><MessageText text={message.body} fromCustomer={message.sender === "customer"}/></p>
              </div></div>)}
            {(processing || deliveryPending) && <p role="status" className="text-sm text-muted">{state?.job?.status === "pending" && !state.job.busy ? "Your message is saved. You can add another message before we reply." : delayed ? "Our reply is taking longer than expected. Your message is saved; please check back shortly." : "PS.Cafe is replying…"}</p>}
            {(state?.job?.status === "dead"||state?.job?.delivery_status==='dead') && <div role="alert" className="text-sm text-danger">We couldn’t complete your reply. Your message is saved.
              <button className="ml-2 underline" disabled={sending} onClick={() => void retryProcessing()}>Try again</button></div>}
            {["failed", "uncertain"].includes(state?.job?.delivery_status ?? "") &&
              <p role="alert" className="text-sm text-danger">Your message is saved, but the reply has not been delivered. Refresh status or ask the business team to review delivery.</p>}
            {state?.providerError && <p role="alert" className="text-sm text-danger">{state.providerFailureCode === "quota_exhausted" ? "The AI provider’s quota is exhausted. Ask the demo operator to check the provider account before retrying." :
                state.providerFailureCode === "authentication" || state.providerFailureCode === "configuration" ? "The assistant configuration needs attention. Ask the demo operator to check it before retrying." :
                state.job?.status === "failed" ? "The AI provider is temporarily unavailable. Your message is saved and will retry automatically after the recovery delay." :
                state.providerFailureCode?.includes("budget") ? "This request exceeded the assistant’s processing limit. Try a shorter request in a new conversation." :
                "The assistant could not complete this request. Your message is saved; you can retry when the provider recovers."}</p>}
            {state?.session?.staff_review_pending && !humanOwned && <p className="rounded-md bg-warning-bg p-3 text-sm">Our team will review the questions that need their help. I can still answer other questions about the restaurant.</p>}
            {humanOwned && <p className="rounded-md bg-warning-bg p-3 text-sm">{state?.session?.status === "closed" ? "Our team has resolved this conversation. Start a new conversation if you need anything else." : "Our team is handling your enquiry. You can continue to send messages here."}</p>}
            <div ref={end}/>
          </div>
          {error && <div role="alert" className="border-t border-line bg-danger-bg p-3 text-sm text-danger">{error}
            <button className="ml-2 underline" onClick={() => { setError(""); if (retry.current) void send(); else void load(); }}>Retry</button></div>}
          <form className="flex gap-2 border-t border-line p-3" onSubmit={event => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="customer-message">Message PS.Cafe Raffles City</label>
            <textarea id="customer-message" rows={2} maxLength={4000} value={text} onChange={event => setText(event.target.value)}
              disabled={loading || sending || !state?.session || state.session.id !== sessionId || state.session.status === "closed"} placeholder="Message PS.Cafe Raffles City…" className="ui-input min-w-0 flex-1 resize-none rounded-xl px-3 py-2 text-sm"/>
            <button aria-label="Send message" className="ui-primary-button self-end px-3 py-3" disabled={loading || !text.trim() || sending || !!state?.job?.busy || (!!processing && state?.job?.status !== "pending") || !state?.session || state.session.id !== sessionId || state.session.status === "closed"}><Send size={18}/></button>
          </form>
          <button onClick={() => { setError(""); void load(); }} className="flex items-center justify-center gap-1 pb-3 text-xs text-muted"><RefreshCw size={12}/>Refresh status</button>
        </section>
      </div>
    </div>
  </main>;
}
