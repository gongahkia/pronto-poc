"use client";
import Image from "next/image";
import { useState } from "react";
import {
  LockKeyhole,
  Trash2,
  Pencil,
  Plus,
  Mail,
  MessageCircle,
} from "lucide-react";
import {
  handoverPresets,
  type Alerts,
  type Handovers,
} from "@/lib/self-serve/catalog";
import { useWorkspace, api, Header, Badge } from "./workspace";
export function HandoversPage() {
  const { state, busy, run } = useWorkspace();
  const settings = state.settings!;
  const handovers = settings.handovers;
  const [custom, setCustom] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [threshold, setThreshold] = useState(
      String(handovers.presets.large_group.params?.min_group_size ?? 10),
    ),
    [contacts, setContacts] = useState<Alerts>(settings.alerts),
    [editContacts, setEditContacts] = useState(false);
  const pending = state.jobs.some(
    (j) =>
      j.kind === "handovers" && ["pending", "processing"].includes(j.status),
  );
  const save = (next: Handovers) =>
    run(
      () =>
        api("/settings", "PATCH", {
          version: settings.version,
          handovers: next,
        }),
      "Handover settings saved.",
    );
  return (
    <>
      <Header
        title="Handovers"
        description="Choose when Pronto steps aside. You reply directly in WhatsApp or Instagram, where the conversation already is."
      />
      <div className="ss-handover-intro">
        <strong>Pronto goes quiet and flags the conversation for you.</strong>
        <p>
          No holding message. When a verified owner reply is detected, Pronto
          can answer the customer’s next message. WhatsApp needs Business App
          coexistence echo events; delivery receipts don’t count.
        </p>
      </div>
      <section className="ss-panel">
        <div className="ss-row ss-wrap">
          <div>
            <h2>Where to alert you</h2>
            <p className="ss-muted">
              Alerts need a configured, verified delivery channel. This public
              demo does not send external staff alerts.
            </p>
          </div>
          <button
            className="ss-secondary"
            onClick={() => {
              setContacts(settings.alerts);
              setEditContacts(!editContacts);
            }}
          >
            {editContacts ? "Cancel" : "Edit contacts"}
          </button>
        </div>
        {editContacts ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await run(
                () =>
                  api("/settings", "PATCH", {
                    version: settings.version,
                    alerts: contacts,
                  }),
                "Alert preferences saved.",
              );
              if (result) setEditContacts(false);
            }}
          >
            <label className="ss-field">
              WhatsApp number
              <input
                type="tel"
                placeholder="+65…"
                value={contacts.whatsapp_number}
                onChange={(e) =>
                  setContacts({ ...contacts, whatsapp_number: e.target.value })
                }
              />
            </label>
            <label className="ss-checkbox">
              <input
                type="checkbox"
                checked={contacts.whatsapp_enabled}
                onChange={(e) =>
                  setContacts({
                    ...contacts,
                    whatsapp_enabled: e.target.checked,
                  })
                }
              />
              Enable WhatsApp alerts
            </label>
            <label className="ss-field">
              Email address
              <input
                type="email"
                value={contacts.email_address}
                onChange={(e) =>
                  setContacts({ ...contacts, email_address: e.target.value })
                }
              />
            </label>
            <label className="ss-checkbox">
              <input
                type="checkbox"
                checked={contacts.email_enabled}
                onChange={(e) =>
                  setContacts({ ...contacts, email_enabled: e.target.checked })
                }
              />
              Enable email alerts
            </label>
            <div className="ss-actions">
              <button className="ss-primary" disabled={busy}>
                Save alert preferences
              </button>
            </div>
          </form>
        ) : (
          <div className="ss-alert-channels">
            <span>
              <MessageCircle size={19} />
              <strong>WhatsApp</strong>
              <span>{settings.alerts.whatsapp_number || "No number set"}</span>
              <Badge
                tone={settings.alerts.whatsapp_enabled ? "green" : "amber"}
              >
                {settings.alerts.whatsapp_enabled ? "Enabled" : "Off"}
              </Badge>
            </span>
            <span>
              <Mail size={19} />
              <strong>Email</strong>
              <span>{settings.alerts.email_address || "No email set"}</span>
              <Badge tone={settings.alerts.email_enabled ? "green" : "amber"}>
                {settings.alerts.email_enabled ? "Enabled" : "Off"}
              </Badge>
            </span>
          </div>
        )}
        <div className="ss-connection-status">
          <Image src="/channel-icons/instagram.png" alt="" width={22} height={22} />
          <div>
            <h3>Instagram customer messages</h3>
            {(state.instagram ?? []).length ? (
              state.instagram!.map((channel) => (
                <p key={channel.id}>
                  {channel.name}{" "}
                  <Badge tone={channel.status === "active" ? "green" : "amber"}>
                    {channel.status === "active"
                      ? "Connected"
                      : channel.status === "disabled"
                        ? "Disabled"
                        : "Setup pending"}
                  </Badge>
                </p>
              ))
            ) : (
              <p className="ss-muted">No Instagram connection configured.</p>
            )}
            <p className="ss-muted">
              This connection receives customer DMs. Owner alerts are configured
              separately above.
            </p>
          </div>
        </div>
        {!settings.alerts.whatsapp_enabled &&
          !settings.alerts.email_enabled && (
            <p className="ss-feedback ss-warning">
              Both alert channels are off. Handovers still pause Pronto, so
              check the Handovers status or your native inbox.
            </p>
          )}
      </section>
      <section className="ss-panel">
        <h2>When to hand over</h2>
        <p className="ss-muted">
          Choose the situations you want to handle. Safety and unsupported
          actions still require a person.
        </p>
        <div className="ss-handover-list">
          {handoverPresets.map((p) => {
            const locked = "locked" in p;
            const enabled = handovers.presets[p.key]?.enabled;
            return (
              <div className="ss-handover-rule" key={p.key}>
                <div className="ss-row">
                  <div>
                    <h3>
                      {p.title}
                      {locked && <LockKeyhole size={14} />}
                    </h3>
                    <p>{p.description}</p>
                  </div>
                  <button
                    className="ss-toggle"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={p.title}
                    disabled={locked || busy}
                    onClick={() =>
                      save({
                        ...handovers,
                        presets: {
                          ...handovers.presets,
                          [p.key]: {
                            ...handovers.presets[p.key],
                            enabled: !enabled,
                          },
                        },
                      })
                    }
                  >
                    <span />
                  </button>
                </div>
                <q className="ss-example">{p.example}</q>
                {p.key === "large_group" && enabled && (
                  <form
                    className="ss-threshold"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void save({
                        ...handovers,
                        presets: {
                          ...handovers.presets,
                          large_group: {
                            enabled: true,
                            params: { min_group_size: Number(threshold) },
                          },
                        },
                      });
                    }}
                  >
                    <label>
                      More than{" "}
                      <input
                        type="number"
                        min={1}
                        max={500}
                        required
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                      />{" "}
                      people
                    </label>
                    <small>
                      {Number(threshold) + 1}+ people will hand over.
                    </small>
                    <button className="ss-secondary" disabled={busy}>
                      Save threshold
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="ss-panel">
        <h2>Your own situations</h2>
        {pending && (
          <p className="ss-feedback ss-info" role="status">
            Pronto is interpreting your situations. They will appear here when
            ready.
          </p>
        )}
        {state.jobs
          .filter((j) => j.kind === "handovers")
          .slice(0, 1)
          .filter((j) => j.status === "failed")
          .map((j) => (
            <p key={j.id} className="ss-feedback ss-error" role="alert">
              {j.error} The situation was not added; review and submit it again.
            </p>
          ))}
        <p className="ss-muted">
          Tell Pronto what you’d rather handle yourself. Separate situations
          become separate rules.
        </p>
        {handovers.custom.map((rule) => (
          <div className="ss-custom-handover" key={rule.id}>
            {editing === rule.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await save({
                    ...handovers,
                    custom: handovers.custom.map((r) =>
                      r.id === rule.id ? { ...r, text: draft.trim() } : r,
                    ),
                  });
                  if (ok) setEditing(null);
                }}
              >
                <label className="ss-field">
                  Handover situation
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={500}
                    required
                  />
                </label>
                <div className="ss-actions">
                  <button
                    type="button"
                    className="ss-secondary"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  <button className="ss-primary" disabled={busy}>
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <div className="ss-row">
                <p>{rule.text}</p>
                <div className="ss-inline">
                  <button
                    className="ss-icon-button"
                    aria-label={"Edit " + rule.text}
                    onClick={() => {
                      setEditing(rule.id);
                      setDraft(rule.text);
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="ss-icon-button ss-danger"
                    aria-label={"Delete " + rule.text}
                    disabled={busy}
                    onClick={() =>
                      save({
                        ...handovers,
                        custom: handovers.custom.filter(
                          (r) => r.id !== rule.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await run(
              () =>
                api("/handovers", "POST", {
                  id: crypto.randomUUID(),
                  text: custom,
                  version: settings.version,
                }),
              "Situations queued for interpretation.",
            );
            if (result) setCustom("");
          }}
        >
          <label className="ss-field">
            Add situations
            <textarea
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              maxLength={10000}
              rows={3}
              required
              placeholder="e.g. Anything about wedding events. Also requests from influencers."
            />
          </label>
          <div className="ss-actions">
            <button
              className="ss-primary"
              disabled={busy || pending || !custom.trim()}
            >
              <Plus size={16} />
              Add situation
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
