"use client";
import { useEffect, useState } from "react";
import {
  MessageCircle,
  Upload,
  Send,
  Plus,
  Trash2,
  LoaderCircle,
  Check,
} from "lucide-react";
import { useWorkspace, api, Header, Badge } from "./workspace";
import { BackToVoice } from "./voice";
import { scenarios } from "@/lib/self-serve/catalog";
type Session = {
  id: string;
  method: "conversation" | "upload";
  status: string;
  replies: { round: number; customer_message: string; owner_reply: string }[];
  draft_notes: string[];
  review_text: string | null;
  speaker_options: string[];
  selected_speaker: string | null;
  error: string | null;
};
export function CustomiseVoice() {
  const { state, busy, run, refresh } = useWorkspace();
  const saved = state.settings!.voice;
  const [session, setSession] = useState<Session | null>(null),
    [reply, setReply] = useState(""),
    [notes, setNotes] = useState<string[]>(saved.custom_notes),
    [files, setFiles] = useState<File[]>([]),
    [consent, setConsent] = useState(false),
    [method, setMethod] = useState<"conversation" | "upload">("conversation"),
    [review, setReview] = useState(""),
    [speaker, setSpeaker] = useState(""),
    [preview, setPreview] = useState<{
      question: string;
      reply: string;
      model: string;
    } | null>(null),
    [previewId, setPreviewId] = useState<string | null>(null);
  const [persisted, setPersisted] = useState(
    JSON.stringify(saved.mode === "custom" ? saved.custom_notes : []),
  );
  const storageKey = "pronto-voice-session:" + state.settings!.client_id;
  const industry = state.settings!.industry;
  const scenario = scenarios[industry];
  const waiting =
    session && ["extracting", "analysing"].includes(session.status);
  const cleanNotes = notes.map((n) => n.trim()).filter(Boolean);
  const isSaved =
    saved.mode === "custom" && JSON.stringify(cleanNotes) === persisted;
  useEffect(() => {
    const id = sessionStorage.getItem(storageKey);
    if (!id) return;
    let ignore = false;
    api<Session>("/voice-sessions/" + id)
      .then((next) => {
        if (
          !ignore &&
          !["saved", "discarded", "failed"].includes(next.status)
        ) {
          setSession(next);
          if (next.status === "ready") setNotes(next.draft_notes);
          if (next.status === "review") setReview(next.review_text ?? "");
        }
      })
      .catch(() => sessionStorage.removeItem(storageKey));
    return () => {
      ignore = true;
    };
  }, [storageKey]);
  useEffect(() => {
    if (!session?.id || !waiting) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = session.id;
    const poll = async () => {
      try {
        const next = await api<Session>("/voice-sessions/" + id);
        if (!stop) {
          setSession(next);
          if (next.status === "ready") setNotes(next.draft_notes);
          if (next.status === "review") {
            setReview(next.review_text ?? "");
            setConsent(false);
          }
        }
      } catch {}
      if (!stop) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [session?.id, waiting]);
  useEffect(() => {
    if (!previewId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await api<{
          status: string;
          result: { question: string; reply: string };
          error: string;
          model: string | null;
        }>("/jobs/" + previewId);
        if (!stop && job.status === "ready") {
          if (!job.model || !job.result?.reply) throw new Error("The preview could not be verified. Generate it again.");
          setPreview({ ...job.result, model: job.model });
          setPreviewId(null);
          return;
        }
        if (job.status === "failed") {
          await run(async () => {
            throw new Error(job.error);
          });
          setPreviewId(null);
          return;
        }
      } catch (failure) {
        if (!stop) {
          setPreviewId(null);
          await run(async () => { throw failure; });
        }
        return;
      }
      if (!stop) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [previewId, run]);
  async function start() {
    const id = crypto.randomUUID();
    let data: unknown = { id, method };
    if (method === "upload") {
      const form = new FormData();
      form.set("id", id);
      form.set("method", method);
      form.set("consent", String(consent));
      files.forEach((f) => form.append("files", f));
      data = form;
    }
    const next = await run(
      () => api<Session>("/voice-sessions", "POST", data),
      method === "upload"
        ? "Samples saved temporarily. Preparing your review."
        : "Reply in your own words.",
    );
    if (next) {
      setSession(next);
      sessionStorage.setItem(storageKey, next.id);
      setNotes([]);
      setPreview(null);
      setConsent(false);
    }
  }
  async function discard() {
    if (session)
      await run(
        () => api("/voice-sessions/" + session.id, "DELETE"),
        "Session discarded. Your active voice has not changed.",
      );
    setSession(null);
    setNotes(saved.custom_notes);
    setReply("");
    setReview("");
    setFiles([]);
    setConsent(false);
    sessionStorage.removeItem(storageKey);
  }
  return (
    <>
      <BackToVoice />
      <Header
        title="Customise my brand voice"
        description="Show Pronto how you text. We’ll turn your replies into a few simple style notes you can edit."
      />
      {!session ? (
        <section className="ss-panel ss-custom-start">
          <div className="ss-two-methods">
            <button
              className="ss-method"
              aria-pressed={method === "conversation"}
              onClick={() => setMethod("conversation")}
            >
              <MessageCircle size={24} />
              <h2>Have a quick conversation</h2>
              <p>
                Reply to 3 sample customer messages as you normally would. About
                2 minutes.
              </p>
              <Badge>Recommended</Badge>
            </button>
            <button
              className="ss-method"
              aria-pressed={method === "upload"}
              onClick={() => setMethod("upload")}
            >
              <Upload size={24} />
              <h2>Upload past chats</h2>
              <p>
                Use a WhatsApp export or screenshots. Review the business-side
                samples before AI analysis.
              </p>
            </button>
          </div>
          {method === "upload" && (
            <div className="ss-upload-options">
              <label className="ss-file">
                <Upload size={22} />
                <strong>
                  {files.length
                    ? `${files.length} file(s) selected`
                    : "Choose chat exports or screenshots"}
                </strong>
                <span>TXT, ZIP, JPG, PNG, WebP or HEIC · 25 MB total</span>
                <input
                  type="file"
                  multiple
                  accept=".txt,.zip,.jpg,.jpeg,.png,.webp,.heic"
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                />
              </label>
              <p className="ss-muted">
                Only upload chats you have permission to use. Files are
                encrypted temporarily and deleted after extraction. You’ll
                choose the business participant or remove customer text, then
                review redacted samples before they go to the configured AI
                provider. Unfinished sessions expire after an hour and are
                cleaned up when processing next runs. Saved style notes remain
                until you replace them.
              </p>
              <label className="ss-checkbox">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I have permission to use these samples.
              </label>
            </div>
          )}
          <div className="ss-actions">
            <button
              className="ss-primary"
              disabled={
                busy || (method === "upload" && (!consent || !files.length))
              }
              onClick={start}
            >
              {method === "upload" ? "Upload & review" : "Start conversation"}
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="ss-row ss-wrap">
            <Badge>
              {session.method === "conversation"
                ? "Sample conversation"
                : "Past chats"}
            </Badge>
            <button
              className="ss-text-button"
              disabled={busy}
              onClick={discard}
            >
              Discard & start again
            </button>
          </div>
          {session.error && (
            <p role="alert" className="ss-feedback ss-error">
              {session.error}
            </p>
          )}
          {session.method === "conversation" && (
            <section className="ss-panel ss-training">
              <div className="ss-row">
                <h2>Reply like you normally would</h2>
                <Badge>{Math.min(session.replies.length + 1, 3)} of 3</Badge>
              </div>
              <p className="ss-muted">
                These are fictional{" "}
                {industry === "dental" ? "clinic" : "restaurant"} enquiries.
                They teach tone, not business facts.
              </p>
              <div className="ss-training-chat">
                {session.replies.map((r) => (
                  <div className="ss-training-round" key={r.round}>
                    <p className="ss-bubble ss-customer">
                      {r.customer_message}
                    </p>
                    <p className="ss-bubble ss-business">{r.owner_reply}</p>
                  </div>
                ))}
                {session.status === "collecting" && (
                  <p className="ss-bubble ss-customer">
                    {scenario.messages[session.replies.length]}
                  </p>
                )}
              </div>
              {session.status === "collecting" && (
                <form
                  className="ss-reply-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const next = await run(
                      () =>
                        api<Session>(
                          `/voice-sessions/${session.id}/reply`,
                          "POST",
                          { round: session.replies.length + 1, reply },
                        ),
                      "Reply saved.",
                    );
                    if (next) {
                      setSession(next);
                      setReply("");
                    }
                  }}
                >
                  <label className="ss-field">
                    <span className="ss-sr">Your reply</span>
                    <textarea
                      rows={2}
                      maxLength={2000}
                      required
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="Text back as yourself…"
                    />
                  </label>
                  <button
                    className="ss-primary"
                    disabled={busy || !reply.trim()}
                    aria-label="Send sample reply"
                  >
                    <Send size={18} />
                  </button>
                </form>
              )}
            </section>
          )}
          {waiting && (
            <div className="ss-panel ss-processing" role="status">
              <LoaderCircle className="ss-spin" size={24} />
              <h2>
                {session.status === "extracting"
                  ? "Reading your samples…"
                  : "Finding your writing style…"}
              </h2>
              <p>You can keep this page open while Pronto works.</p>
            </div>
          )}
          {session.status === "review" && (
            <section className="ss-panel">
              <h2>Review business-side samples</h2>
              {session.speaker_options.length > 0 ? (
                <>
                  <p>
                    Select the person replying on behalf of the business.
                    Customer messages won’t be used for style analysis.
                  </p>
                  <label className="ss-field">
                    Business participant
                    <select
                      value={speaker}
                      onChange={(e) => setSpeaker(e.target.value)}
                    >
                      <option value="">Choose a participant</option>
                      {session.speaker_options.map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="ss-primary"
                    disabled={busy || !speaker}
                    onClick={async () => {
                      const next = await run(
                        () =>
                          api<Session>(
                            `/voice-sessions/${session.id}/speaker`,
                            "POST",
                            { speaker },
                          ),
                        "Business replies selected. Review and remove any remaining personal details.",
                      );
                      if (next) {
                        setSession(next);
                        setReview(next.review_text ?? "");
                      }
                    }}
                  >
                    Use business replies
                  </button>
                </>
              ) : (
                <>
                  <p>
                    Keep only messages written by your business. For
                    screenshots, remove customer bubbles and OCR mistakes. Names
                    can be missed: remove remaining personal details before
                    continuing.
                  </p>
                  <label className="ss-field">
                    Samples to analyse
                    <textarea
                      rows={12}
                      value={review}
                      onChange={(e) => setReview(e.target.value)}
                      maxLength={30000}
                    />
                  </label>
                  <label className="ss-checkbox">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    These are permissioned business-side samples, reviewed for
                    personal details.
                  </label>
                  <div className="ss-actions">
                    <button
                      className="ss-primary"
                      disabled={busy || !consent || review.trim().length < 20}
                      onClick={async () => {
                        const next = await run(
                          () =>
                            api<Session>(
                              `/voice-sessions/${session.id}/analyse`,
                              "POST",
                              {
                                text: review,
                                speaker: session.selected_speaker ?? "business",
                                consent,
                              },
                            ),
                          "Samples sent for style analysis.",
                        );
                        if (next) setSession(next);
                      }}
                    >
                      Analyse style
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
      {(session?.status === "ready" ||
        (!session && saved.custom_notes.length > 0)) && (
        <section className="ss-panel ss-notes">
          <div className="ss-row ss-wrap">
            <h2>Here’s what Pronto learned</h2>
            {isSaved && (
              <span className="ss-saved">
                <Check size={16} />
                Saved as your brand voice
              </span>
            )}
          </div>
          <p className="ss-muted">
            Keep what sounds like you. Edit or remove anything that doesn’t.
            These notes guide style only.
          </p>
          {notes.map((note, index) => (
            <label className="ss-note" key={index}>
              <span className="ss-sr">Style note {index + 1}</span>
              <textarea
                value={note}
                rows={2}
                maxLength={1600}
                onChange={(e) => {
                  setNotes(
                    notes.map((n, i) => (i === index ? e.target.value : n)),
                  );
                  setPreview(null);
                  setPreviewId(null);
                }}
              />
              <button
                className="ss-icon-button ss-danger"
                aria-label={"Delete style note " + (index + 1)}
                onClick={() => { setNotes(notes.filter((_, i) => i !== index)); setPreview(null); setPreviewId(null); }}
              >
                <Trash2 size={16} />
              </button>
            </label>
          ))}
          <button
            className="ss-text-button"
            disabled={notes.length >= 20}
            onClick={() => { setNotes([...notes, ""]); setPreview(null); setPreviewId(null); }}
          >
            <Plus size={16} />
            Add a note
          </button>
          <div className="ss-actions">
            <button
              className="ss-secondary"
              disabled={busy || !!previewId || !cleanNotes.length}
              onClick={async () => {
                setPreview(null);
                const result = await run(
                  () =>
                    api<{ id: string }>("/preview", "POST", {
                      id: crypto.randomUUID(),
                      notes: cleanNotes,
                    }),
                  "Generating a sample reply.",
                );
                if (result) setPreviewId(result.id);
              }}
            >
              {previewId ? "Generating preview…" : "Preview a reply"}
            </button>
            <button
              className="ss-primary"
              disabled={busy || isSaved || !cleanNotes.length}
              onClick={async () => {
                const result = await run(
                  () =>
                    api("/voice", "PUT", {
                      version: state.settings!.version,
                      mode: "custom",
                      custom_notes: cleanNotes,
                      custom_origin:
                        session?.method ?? saved.custom_origin ?? "existing",
                      ...(session ? { sessionId: session.id } : {}),
                    }),
                  "Your custom voice is live.",
                );
                if (result) {
                  setPersisted(JSON.stringify(cleanNotes));
                  setSession(null);
                  sessionStorage.removeItem(storageKey);
                  await refresh();
                }
              }}
            >
              Save my brand voice
            </button>
          </div>
          {preview && (
            <div className="ss-preview-result">
              <Badge>AI preview · {preview.model}</Badge>
              <p className="ss-bubble ss-customer">{preview.question}</p>
              <p className="ss-bubble ss-business">{preview.reply}</p>
              <small>
                No booking, appointment or other action is performed.
              </small>
            </div>
          )}
        </section>
      )}
    </>
  );
}
