"use client";
import Link from "next/link";
import { Layers, MessageCircle, TriangleAlert } from "lucide-react";
import { useWorkspace, Header, Badge } from "./workspace";
import { voicePresets, previewReplies } from "@/lib/self-serve/catalog";
export function SelfServeHome() {
  const { state, name } = useWorkspace();
  const settings = state.settings!;
  const current = voicePresets.find((p) => p.id === settings.voice.preset_id)!;
  const review = new Set(state.conflicts.flatMap((c) => [c.rule_a, c.rule_b]));
  return (
    <>
      <Header
        title={`Hello, ${name}`}
        description="Here’s what your agent knows and how it sounds."
      />
      <div className="ss-home-grid">
        <section className="ss-panel">
          <div className="ss-row">
            <h2>
              <span className="ss-icon">
                <Layers size={18} />
              </span>
              Business rules
            </h2>
            <Link className="ss-secondary" href="/client/rules">
              Manage
            </Link>
          </div>
          <div className="ss-stats">
            <div>
              <strong>{state.sources.length}</strong>
              <span>Sources</span>
            </div>
            <div>
              <strong>{state.rules.filter((r) => r.live).length}</strong>
              <span>Rules live</span>
            </div>
            <div className={review.size ? "ss-warning" : ""}>
              <strong>{review.size}</strong>
              <span>Need review</span>
            </div>
          </div>
          {review.size > 0 ? (
            <Link
              className="ss-conflict-link"
              href="/client/rules?filter=review"
            >
              <TriangleAlert size={18} />
              <span>
                Your rules disagree on{" "}
                {new Set(state.conflicts.map((c) => c.topic)).size} topic(s).
                Resolve them so your agent can answer.
              </span>
              <strong>Review →</strong>
            </Link>
          ) : (
            <p className="ss-muted">
              {state.rules.length
                ? "Your checked rules are ready for customer enquiries."
                : "Add your first source to teach Pronto about your business."}
            </p>
          )}
        </section>
        <section className="ss-panel">
          <div className="ss-row">
            <h2>
              <span className="ss-icon">
                <MessageCircle size={18} />
              </span>
              Brand voice
            </h2>
            <Link className="ss-secondary" href="/client/voice">
              Change
            </Link>
          </div>
          <div className="ss-inline">
            <strong>
              {settings.voice.mode === "custom"
                ? "Your custom voice"
                : current.name}
            </strong>
            <Badge>
              {settings.voice.mode === "custom" ? "Custom" : "Preset"}
            </Badge>
          </div>
          {settings.voice.mode === "preset" ? (
            <div className="ss-chat-mini">
              <p>Hi! Do you have a table for 4 tonight around 8?</p>
              <p>{previewReplies(current.id)[0]}</p>
            </div>
          ) : (
            <p className="ss-voice-excerpt">
              {settings.voice.custom_notes.slice(0, 2).join(" ")}
            </p>
          )}
          <Link className="ss-link" href="/client/voice/customise">
            Want it to sound more like you? Customise your voice →
          </Link>
        </section>
      </div>
    </>
  );
}
