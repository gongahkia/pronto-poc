"use client";
import { useState, type FormEvent } from "react";
import {
  Layers,
  FileText,
  Link as LinkIcon,
  AlignLeft,
  Plus,
  Upload,
  ChevronDown,
  TriangleAlert,
  Trash2,
  Pencil,
  LoaderCircle,
} from "lucide-react";
import { useWorkspace, api, Header, Badge, type RuleView } from "./workspace";
export function BusinessRules() {
  const { state, busy, run } = useWorkspace();
  const [adding, setAdding] = useState(!state.sources.length),
    [type, setType] = useState("text"),
    [text, setText] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [label, setLabel] = useState(""),
    [reviewOnly, setReviewOnly] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const version = state.settings!.version;
  const conflictIds = new Set(
    state.conflicts.flatMap((c) => [c.rule_a, c.rule_b]),
  );
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData();
    data.set("id", requestId);
    data.set("type", type);
    data.set(
      "label",
      label.trim() ||
        file?.name ||
        (type === "url"
          ? url
          : "Notes " + new Date().toLocaleDateString("en-SG")),
    );
    data.set("text", text);
    data.set("url", url);
    if (file) data.set("file", file);
    const result = await run(
      () => api("/sources", "POST", data),
      "Source added. Pronto is extracting and checking its rules.",
    );
    if (result) {
      setRequestId(crypto.randomUUID());
      setAdding(false);
      setText("");
      setUrl("");
      setLabel("");
      setFile(null);
    }
  }
  return (
    <>
      <Header
        title="Business rules"
        description="Add anything that describes how your business works, one source at a time. Pronto reads each source and turns it into rules your agent follows when replying to customers."
      />
      <section className="ss-panel ss-rules-panel">
        <div className="ss-row ss-wrap">
          <div className="ss-inline">
            <h2>Rules by source</h2>
            <Badge tone="green">
              {state.rules.filter((r) => r.live).length} rules live
            </Badge>
            {conflictIds.size > 0 && (
              <Badge tone="amber">{conflictIds.size} need review</Badge>
            )}
          </div>
          <div className="ss-inline">
            <div className="ss-segment" role="group" aria-label="Filter rules">
              <button
                aria-pressed={!reviewOnly}
                onClick={() => setReviewOnly(false)}
              >
                All rules
              </button>
              <button
                aria-pressed={reviewOnly}
                onClick={() => setReviewOnly(true)}
              >
                Needs review
              </button>
            </div>
            {!adding && (
              <button className="ss-primary" onClick={() => setAdding(true)}>
                <Plus size={16} />
                Add source
              </button>
            )}
          </div>
        </div>
        {(adding || !state.sources.length) && (
          <form className="ss-add-source" onSubmit={add}>
            <div className="ss-row ss-wrap">
              <strong>Add a source</strong>
              <span className="ss-muted">
                Text, files or links. Links are imported once.
              </span>
            </div>
            <div className="ss-source-input">
              <div className="ss-segment" role="group" aria-label="Source type">
                {[
                  { id: "text", name: "Free text", Icon: AlignLeft },
                  { id: "file", name: "File", Icon: FileText },
                  { id: "url", name: "Link", Icon: LinkIcon },
                ].map(({ id, name, Icon }) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={type === id}
                    onClick={() => setType(id)}
                  >
                    <Icon size={14} />
                    {name}
                  </button>
                ))}
              </div>
              <label className="ss-field">
                Source name <span className="ss-muted">(optional)</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={160}
                  placeholder="e.g. Menu & policies"
                />
              </label>
              {type === "text" ? (
                <label className="ss-field">
                  <span className="ss-sr">Business information</span>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="e.g. We’re closed on Mondays. Groups of 6 or more need a S$10 per person deposit, refundable with 24 hours’ notice."
                    maxLength={10000}
                    rows={4}
                    required
                  />
                  <small>
                    {text.length.toLocaleString()} / 10,000 characters
                  </small>
                </label>
              ) : type === "url" ? (
                <label className="ss-field">
                  Public page URL
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://yourbusiness.com/menu"
                    required
                  />
                  <small>
                    One page only. Changes to the website are not synced
                    automatically.
                  </small>
                </label>
              ) : (
                <label className="ss-file">
                  <Upload size={22} />
                  <strong>{file?.name ?? "Choose a file"}</strong>
                  <span>
                    PDF, Word, text, CSV, Excel or image · up to 25 MB
                  </span>
                  <input
                    type="file"
                    required
                    accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.jpg,.jpeg,.png,.webp,.heic"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              )}
            </div>
            <div className="ss-actions">
              {state.sources.length > 0 && (
                <button
                  type="button"
                  className="ss-secondary"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </button>
              )}
              <button className="ss-primary" disabled={busy}>
                Add
              </button>
            </div>
          </form>
        )}
        {!state.sources.length ? (
          <div className="ss-empty">
            <span className="ss-icon">
              <Layers size={22} />
            </span>
            <h3>No rules yet</h3>
            <p>
              Add your first source. Each one becomes a set of rules,
              <br />
              grouped here under the source it came from.
            </p>
          </div>
        ) : (
          <div className="ss-sources">
            {state.sources
              .filter(
                (s) =>
                  !reviewOnly ||
                  state.rules.some(
                    (r) => r.source_id === s.id && conflictIds.has(r.id),
                  ),
              )
              .map((s) => {
                const rules = state.rules.filter(
                  (r) =>
                    r.source_id === s.id &&
                    (!reviewOnly || conflictIds.has(r.id)),
                );
                return (
                  <details key={s.id} className="ss-source" open>
                    <summary>
                      <span className="ss-icon">
                        <FileText size={18} />
                      </span>
                      <span>
                        <strong>{s.label}</strong>
                        <small>
                          {s.status === "processing"
                            ? "Processing…"
                            : s.status === "failed"
                              ? "Could not process"
                              : `${rules.length} rules · ${new Date(s.created_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}`}
                        </small>
                      </span>
                      <ChevronDown size={17} />
                    </summary>
                    <div className="ss-source-body">
                      {s.status === "processing" && (
                        <p className="ss-inline ss-muted">
                          <LoaderCircle className="ss-spin" size={16} />
                          Extracting facts and checking for conflicts. This
                          source is not live yet.
                        </p>
                      )}
                      {s.error && (
                        <p className="ss-feedback ss-error">
                          {s.error}
                          <button
                            className="ss-secondary"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => api(`/sources/${s.id}/retry`, "POST"),
                                "Source queued again.",
                              )
                            }
                          >
                            Retry
                          </button>
                        </p>
                      )}
                      {s.status === "ready" && !rules.length && (
                        <p className="ss-muted">
                          No usable business rules were found in this source.
                        </p>
                      )}
                      {rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} />
                      ))}
                      <div className="ss-actions">
                        <button
                          className="ss-text-button ss-danger"
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                "Remove this source and its rules? Conversation history will be kept.",
                              )
                            )
                              void run(
                                () =>
                                  api(`/sources/${s.id}`, "DELETE", {
                                    version,
                                  }),
                                "Source removed.",
                              );
                          }}
                        >
                          <Trash2 size={14} />
                          Remove source
                        </button>
                      </div>
                    </div>
                  </details>
                );
              })}
            {reviewOnly && !conflictIds.size && (
              <p className="ss-empty">No conflicts to review.</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
function RuleRow({ rule }: { rule: RuleView }) {
  const { state, run, busy } = useWorkspace();
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(rule.text);
  const conflicts = state.conflicts.filter(
    (c) => c.rule_a === rule.id || c.rule_b === rule.id,
  );
  const version = state.settings!.version;
  return (
    <article
      className={"ss-rule " + (conflicts.length ? "ss-rule-conflict" : "")}
    >
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () => api(`/rules/${rule.id}`, "PATCH", { version, text: draft }),
              "Rule saved and queued for conflict checks.",
            );
            if (ok) setEditing(false);
          }}
        >
          <label className="ss-field">
            Edit rule
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1600}
              rows={3}
              required
            />
          </label>
          <div className="ss-actions">
            <button
              type="button"
              className="ss-secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button className="ss-primary" disabled={busy}>
              Save & check
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="ss-row">
            <p>{rule.text}</p>
            <div className="ss-inline">
              <button
                className="ss-icon-button"
                aria-label={"Edit " + rule.text}
                onClick={() => {
                  setDraft(rule.text);
                  setEditing(true);
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="ss-icon-button ss-danger"
                aria-label={"Delete " + rule.text}
                disabled={busy}
                onClick={() =>
                  run(
                    () => api(`/rules/${rule.id}`, "DELETE", { version }),
                    "Rule deleted.",
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          <small className="ss-muted">
            {rule.ref} ·{" "}
            {rule.live ? "Live" : rule.checked ? "Withheld" : "Checking…"}
          </small>
        </>
      )}
      {conflicts.map((c) => {
        const other = state.rules.find(
          (r) => r.id === (c.rule_a === rule.id ? c.rule_b : c.rule_a),
        );
        const source = state.sources.find((s) => s.id === other?.source_id);
        return (
          <div className="ss-conflict-detail" key={c.id}>
            <strong>
              <TriangleAlert size={15} />
              Conflicts with {source?.label ?? "another rule"}
            </strong>
            <p>{other?.text}</p>
            <small>{c.explanation}</small>
            {!editing && (
              <button
                className="ss-secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api(`/rules/${rule.id}/keep`, "POST", { version }),
                    "Kept this rule and removed its conflicting alternatives.",
                  )
                }
              >
                Keep this rule
              </button>
            )}
          </div>
        );
      })}
    </article>
  );
}
