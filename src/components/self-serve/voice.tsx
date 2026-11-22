"use client";
import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  Pencil,
} from "lucide-react";
import { useWorkspace, api, Header, Badge } from "./workspace";
import {
  voicePresets,
  type PresetId,
} from "@/lib/self-serve/catalog";
import { ModelVoicePreview } from "./voice-preview";
export function BrandVoice() {
  const { state, busy, run } = useWorkspace();
  const saved = state.settings!.voice;
  const [selected, setSelected] = useState<PresetId>(saved.preset_id);
  const preset = voicePresets.find((p) => p.id === selected)!;
  const current = saved.mode === "preset" && saved.preset_id === selected;
  return (
    <>
      <Header
        title="Brand voice"
        description="Choose how Pronto sounds when it texts your customers. Select a style and generate an AI preview, or teach Pronto your own."
      >
        <div className="ss-inline">
          <Link className="ss-secondary" href="/client/home">
            Back
          </Link>
          {current ? (
            <span className="ss-saved">
              <Check size={16} />
              {preset.name} is your current voice
            </span>
          ) : (
            <button
              className="ss-primary"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api("/voice", "PUT", {
                      version: state.settings!.version,
                      mode: "preset",
                      preset_id: selected,
                    }),
                  `${preset.name} is now your active voice.`,
                )
              }
            >
              Use {preset.name}
            </button>
          )}
        </div>
      </Header>
      <div className="ss-voice-layout">
        <section className="ss-presets" aria-label="Voice styles">
          {voicePresets.map((p) => (
            <button
              className="ss-preset"
              key={p.id}
              aria-pressed={selected === p.id}
              onClick={() => setSelected(p.id)}
            >
              <span className="ss-row">
                <strong>{p.name}</strong>
                <span className="ss-radio" />
              </span>
              {"badge" in p && <Badge>{p.badge}</Badge>}
              <p>{p.description}</p>
            </button>
          ))}
          <Link className="ss-custom-card" href="/client/voice/customise">
            <div className="ss-inline">
              <span className="ss-icon">
                <Pencil size={18} />
              </span>
              <h3>Customise my brand voice</h3>
              {saved.mode === "custom" && <Badge tone="green">Active</Badge>}
            </div>
            <p>
              Reply to 3 sample customer messages, or upload past chats, and
              Pronto learns how you text. Replaces the preset styles above.
            </p>
            <strong>Start · about 2 min →</strong>
          </Link>
        </section>
        <div className="ss-preview">
          <p className="ss-preview-label">Preview · {preset.name}</p>
          <ModelVoicePreview key={selected} presetId={selected} />
        </div>
      </div>
    </>
  );
}
export function BackToVoice() {
  return (
    <Link className="ss-back" href="/client/voice">
      <ArrowLeft size={17} />
      Back to brand voice
    </Link>
  );
}
