import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canViewBusinessConversation, hasStaffCapability } from "@/lib/staff-permissions";
import {
  getClient,
  getConversationActionableEscalation,
  getConversationMessages,
  getConversationTriageDetail,
} from "@/lib/dashboard";
import { AppShell } from "@/components/shell";
import { ConversationTriagePanel } from "@/components/conversation-triage-panel";
import { ConversationReviewPanel } from "@/components/conversation-review-panel";
import { ConversationClassificationPanel } from "@/components/conversation-classification-panel";
import { getEscalationPolicy } from "@/lib/staff-configuration";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConversationTabs } from "@/components/conversation-tabs";
import { getConversationDecisionTraces } from "@/lib/conversation-decision-traces";

export default async function ClientConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const user = await requireUser("client");
  if (!user.clientId) {
    redirect("/access?reason=membership");
  }
  if (!await canViewBusinessConversation(user, user.clientId)) redirect("/access?reason=permission");
  const { conversationId } = await params;
  const [client, conversation] = await Promise.all([
    getClient(user.clientId),
    getConversationTriageDetail({ clientId: user.clientId, conversationId }),
  ]);
  if (!client || !conversation) {
    notFound();
  }
  const [activeEscalation, messages, decisions] = await Promise.all([
    getConversationActionableEscalation({ clientId: user.clientId, conversationId }),
    getConversationMessages(conversation.id, user.clientId),
    getConversationDecisionTraces(user.clientId, conversation.id),
  ]);
  const [canRespond, canRelease] = await Promise.all([
    hasStaffCapability(user, user.clientId, "conversation.respond"),
    hasStaffCapability(user, user.clientId, "conversation.release"),
  ]);

  const returnTo = `/client/conversations/${conversation.id}`;
  const policy = await getEscalationPolicy(user.clientId);

  return (
    <AppShell user={user} active="client" clientActive="inbox" workspaceName={client.name} workspaceProfile={client.business_profile}>
      <AutoRefresh intervalMs={3000}/>
      <div className="mb-5 flex items-center gap-3">
        <Link href="/client/inbox" aria-label="Back to inbox" title="Back to inbox"
          className="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <ArrowLeft size={20} aria-hidden="true"/>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {conversation.customer_name ?? conversation.customer_handle ?? "Customer conversation"}
          </h1>
          <p className="text-sm text-muted">
            Review this thread and reply when Pronto needs help.
          </p>
        </div>
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ConversationTabs decisions={decisions}><ConversationReviewPanel conversation={conversation} messages={messages}
          footer={<ConversationTriagePanel escalation={activeEscalation} returnTo={returnTo}
            canRespond={canRespond} canRelease={canRelease} />} /></ConversationTabs>
        <ConversationClassificationPanel conversation={conversation} canRespond={canRespond} policy={policy?.policy ?? null}/>
      </div>
    </AppShell>
  );
}
