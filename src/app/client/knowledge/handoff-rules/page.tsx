import { requireUser } from "@/lib/auth";
import { getBusinessReplySettings } from "@/lib/knowledge/reply-settings";
import { AppShell } from "@/components/shell";
import { BusinessKnowledgeDetailHeader } from "@/components/business-knowledge-card";
import { HandoffRulesStatus, HandoffRulesSummary } from "@/components/business-reply-settings";
import { ClientRulesEditor } from "@/components/client-rules-editor";

export default async function HandoffRulesPage() {
  const user = await requireUser("client");
  if (!user.clientId) throw new Error("Business assignment required.");
  const settings = await getBusinessReplySettings(user.clientId);
  return <AppShell user={user} active="client" clientActive="knowledge" workspaceName={settings.client.name} workspaceProfile={settings.client.business_profile}>
    <BusinessKnowledgeDetailHeader title="Handoff rules" description="When the model should involve your team and pause assistant replies." status={<HandoffRulesStatus settings={settings}/>}/>
    <div className="space-y-5">
      <section className="ui-panel"><h2 className="p-5 font-semibold">{settings.draft?.flow ? "Saved policy draft" : "Current handoff policy"}</h2><HandoffRulesSummary settings={settings}/></section>
      <section className="ui-panel p-5"><h2 className="mb-4 font-semibold">Edit handoff policy</h2><ClientRulesEditor initialFlow={settings.flow} initialVersion={settings.draft?.edit_version ?? 0} embedded/></section>
    </div>
  </AppShell>;
}
