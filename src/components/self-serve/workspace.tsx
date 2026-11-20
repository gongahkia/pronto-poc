"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  House,
  Inbox,
  Layers,
  MessageCircle,
  ArrowRight,
  LoaderCircle,
  MessagesSquare,
  Settings as SettingsIcon,
} from "lucide-react";
import type { Settings } from "@/lib/self-serve/store";
export type SourceView = {
  id: string;
  type: string;
  label: string;
  status: string;
  revision: number;
  error: string | null;
  created_at: string;
};
export type RuleView = {
  id: string;
  source_id: string;
  text: string;
  ref: string;
  topic: string;
  live: boolean;
  checked: boolean;
  revision: number;
};
export type State = {
  settings: Settings | null;
  instagram?: { id: string; name: string; status: string }[];
  sources: SourceView[];
  rules: RuleView[];
  conflicts: {
    id: string;
    rule_a: string;
    rule_b: string;
    topic: string;
    explanation: string;
  }[];
  jobs: { id: string; kind: string; status: string; error: string | null }[];
};
export async function api<T = State>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/self-serve" + path, {
    method,
    cache: "no-store",
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...(body !== undefined
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to save. Try again.");
  return result;
}
type Workspace = {
  state: State;
  name: string;
  busy: boolean;
  error: string;
  notice: string;
  refresh: () => Promise<void>;
  run: <T>(work: () => Promise<T>, message?: string) => Promise<T | undefined>;
};
const Context = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("Workspace context missing.");
  return value;
}
export function SelfServeWorkspace({
  name,
  initial,
  children,
}: {
  name: string;
  initial: State;
  children: React.ReactNode;
}) {
  const [state, setState] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [noticeRoute, setNoticeRoute] = useState("");
  const path = usePathname();
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const next = await api();
    if (alive.current)
      setState((previous) =>
        previous.settings &&
        (!next.settings ||
          BigInt(next.settings.version) < BigInt(previous.settings.version))
          ? previous
          : next,
      );
  }, []);
  const run = useCallback(
    async <T,>(work: () => Promise<T>, message = "Saved.") => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await work();
        await refresh();
        setNoticeRoute(path);
        setNotice(message);
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to save. Try again.");
        await refresh().catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [refresh, path],
  );
  const hasPending = state.jobs.some(
    (j) => j.status === "pending" || j.status === "processing",
  );
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        if (hasPending) await api("/process", "POST");
        await refresh();
      } catch {
        if (!stopped)
          setError(
            "Processing is temporarily unavailable. Your work is saved; keep this page open to retry.",
          );
      }
      if (!stopped) timer = setTimeout(tick, hasPending ? 1200 : 12000);
    };
    timer = setTimeout(tick, hasPending ? 300 : 12000);
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh, hasPending]);
  const nav = [
    { href: "/client/home", label: "Home", Icon: House },
    { href: "/client/handovers", label: "Handovers", Icon: Inbox },
    { href: "/client/rules", label: "Business rules", Icon: Layers },
    { href: "/client/voice", label: "Brand voice", Icon: MessageCircle },
    {
      href: "/client/conversations",
      label: "Conversations",
      Icon: MessagesSquare,
    },
    { href: "/client/settings", label: "Settings", Icon: SettingsIcon },
  ];
  return (
    <Context.Provider
      value={{ state, name, busy, error, notice, refresh, run }}
    >
      <div className="selfserve">
        <a className="ss-skip" href="#workspace-content">
          Skip to content
        </a>
        <aside className="ss-sidebar">
          <Link href="/client/home" className="ss-logo">
            <span>P</span>Pronto
          </Link>
          <nav aria-label="Workspace">
            {nav.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={path.startsWith(href) ? "page" : undefined}
              >
                <Icon size={17} />
                {label}
              </Link>
            ))}
          </nav>
          <div className="ss-help">
            <strong>Need a hand?</strong>
            <p>Talk through your setup with the Pronto team.</p>
            <span
              className="ss-disabled-consult"
              title="Booking link coming soon"
            >
              <button disabled>
                Book a consult
              </button>
            </span>
          </div>
          <Link className="ss-switch" href="/demo">
            Switch demo view <ArrowRight size={14} />
          </Link>
        </aside>
        <main id="workspace-content" className="ss-main">
          {error && (
            <div className="ss-feedback ss-error" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {notice && noticeRoute === path && (
            <div className="ss-feedback ss-success" role="status">
              {notice}
            </div>
          )}
          {!state.settings ? (
            <section className="ss-panel">
              <h1>Welcome to Pronto</h1>
              <p>
                Bring your existing knowledge and voice into the self-serve
                workspace. Your conversation history stays with this business.
              </p>
              <button
                className="ss-primary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api("/initialize", "POST"),
                    "Workspace prepared. Sources are being checked.",
                  )
                }
              >
                Prepare workspace
              </button>
            </section>
          ) : (
            <>
              {!state.settings.enabled && (
                <p className="ss-feedback ss-info" role="status">
                  <LoaderCircle className="ss-spin" size={16} />
                  Your existing sources are being checked. Customer replies keep
                  using the previous configuration until the import is ready.
                </p>
              )}
              {children}
            </>
          )}
        </main>
      </div>
    </Context.Provider>
  );
}
export function Header({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="ss-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
export function Badge({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: "blue" | "green" | "amber";
}) {
  return <span className={"ss-badge ss-" + tone}>{children}</span>;
}
