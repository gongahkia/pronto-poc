import { Inbox, LogOut, BookOpenText, ChartNoAxesCombined } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import type { SessionUser } from "@/lib/auth";
import { DEMO_CLIENT_ID } from "@/lib/customer-demo-boundary";
import { PsCafeLogo } from "@/components/ps-cafe-logo";
import { WorkspaceMenu } from "@/components/workspace-menu";
import { DemoFeedback } from "@/components/demo-feedback";
import { isGuestEmail, guestAccessEnabled } from "@/lib/guest-policy";
import {DemoViewSwitch} from '@/components/demo-view-switch';
import {DemoQueuePump} from '@/components/demo-queue-pump';
import {requestDrivenDemoProcessing} from '@/lib/deployment-profile';

type ClientSection = "knowledge" | "inbox" | "assistant" | "analytics";
type ClientSidebarItem = { href: string; label: string; section: ClientSection; icon: typeof Inbox };
const clientSidebarItems: ClientSidebarItem[] = [
  { href: "/client/inbox", label: "Inbox", section: "inbox", icon: Inbox },
  { href: "/client/knowledge", label: "Business Knowledge", section: "knowledge", icon: BookOpenText },
  { href: "/client/analytics", label: "Insights", section: "analytics", icon: ChartNoAxesCombined },
];

export function AppShell({ user, children, clientActive = "inbox", workspaceName }: {
  user: SessionUser; children: ReactNode; active: "client";
  clientActive?: ClientSection; workspaceName?: string;
}) {
  if (user.role !== "client") throw new Error("The business workspace requires a business account.");
  const psCafe = user.clientId === DEMO_CLIENT_ID;
  const displayName = psCafe ? (workspaceName ?? "PS.Cafe Raffles City").replace(/\s+\((?:unofficial )?demo\)$/, "")
    : workspaceName ?? "Client workspace";
  // Guests have a placeholder address; show their name instead.
  const shownEmail = isGuestEmail(user.email) ? `${user.name} (guest reviewer)` : user.email;
  return <>
    <AutoRefresh/>
    {psCafe&&requestDrivenDemoProcessing()&&<DemoQueuePump/>}
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <div className="min-h-screen bg-background text-foreground lg:flex">
      <ClientSidebar active={clientActive} email={shownEmail} workspaceName={displayName} psCafe={psCafe}/>
      <div className="min-w-0 flex-1">
        <header className="border-b border-line bg-panel/95 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <WorkspaceMenu name={displayName} email={shownEmail} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-foreground">
              {psCafe ? <PsCafeLogo/> : <><span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white">P</span>Pronto</>}
            <span className="min-w-0 flex-1 px-1">
              <span className="block truncate text-sm font-medium">{displayName}</span>
              <span className="block truncate text-xs text-muted">{shownEmail}</span>
            </span>
            </WorkspaceMenu>
            <form action="/api/auth/logout" method="post">
              <button className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-panel text-muted hover:bg-surface-hover hover:text-link" title="Log out" aria-label="Log out">
                <LogOut size={15} aria-hidden="true"/>
              </button>
            </form>
          </div>
          <ClientMobileNav active={clientActive}/>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
          {psCafe && guestAccessEnabled() && <div className="mb-4 flex justify-end"><DemoViewSwitch/></div>}
          {children}
        </main>
      </div>
    </div>
    {psCafe && process.env.PRONTO_CUSTOMER_DEMO_ENABLED === "1" && <DemoFeedback/>}
  </>;
}

function ClientSidebar({
  active,
  email,
  workspaceName,
  psCafe,
}: {
  active: ClientSection;
  email: string;
  workspaceName: string;
  psCafe: boolean;
}) {
  const initials = workspaceName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <aside className="sticky top-0 hidden h-screen w-[18rem] shrink-0 flex-col border-r border-sidebar-line bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex items-center gap-2 px-4 py-4">
        <WorkspaceMenu name={workspaceName} email={email}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-base font-medium hover:bg-sidebar-active">
          {psCafe ? <PsCafeLogo/> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-xs font-bold text-sidebar">
            {initials || "P"}
          </span>}
          <span className="truncate">{workspaceName}</span>
        </WorkspaceMenu>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3 text-base">
        <div>
          <div className="mb-2 flex items-center justify-between px-2 text-sm font-medium text-sidebar-muted">
            <span>Workspace</span>
          </div>
          <div className="space-y-1">
            {clientSidebarItems.map((item) => {
              const Icon = item.icon;
              const isActive = (active === "assistant" ? "knowledge" : active) === item.section;

              return (
                <Link
                  key={item.section}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex h-9 items-center gap-2 rounded-md px-2 font-medium ${
                    isActive
                      ? "bg-sidebar-active text-sidebar-foreground"
                      : "text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      <div className="border-t border-sidebar-line p-3">
        <p className="truncate px-2 pb-2 text-xs text-sidebar-muted">{email}</p>
        <form action="/api/auth/logout" method="post">
          <button
            className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-foreground"
            title="Log out"
          >
            <LogOut size={15} aria-hidden="true" />
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}

function ClientMobileNav({ active }: { active: ClientSection }) {
  return (
    <nav className="grid grid-cols-3 gap-1 border-t border-line px-3 py-2 text-sm">
      {clientSidebarItems.map((item) => (
        <Link
          key={item.section}
          href={item.href}
          aria-current={(active === "assistant" ? "knowledge" : active) === item.section ? "page" : undefined}
          className={`flex items-center justify-center rounded-md px-2 py-1.5 text-center font-medium ${
            (active === "assistant" ? "knowledge" : active) === item.section
              ? "bg-surface text-link"
              : "text-muted hover:bg-surface-hover hover:text-link"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
