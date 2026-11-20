import {redirect} from 'next/navigation';
import {selfServeUIEnabled} from '@/lib/self-serve/settings';
import { requireUser } from "@/lib/auth";
import { getBusinessReplySettings } from "@/lib/knowledge/reply-settings";
import { AppShell } from "@/components/shell";
import { BusinessKnowledgeDetailHeader } from "@/components/business-knowledge-card";
import { BrandVoiceStatus, BrandVoiceSummary } from "@/components/business-reply-settings";
import { ClientVoiceEditor } from "@/components/client-voice-editor";

export default async function BrandVoicePage() {
  const user = await requireUser("client");
  if(selfServeUIEnabled())redirect("/client/voice");
  if (!user.clientId) throw new Error("Business assignment required.");
  const settings = await getBusinessReplySettings(user.clientId);
  return <AppShell user={user} active="client" clientActive="knowledge" workspaceName={settings.client.name} workspaceProfile={settings.client.business_profile}>
    <BusinessKnowledgeDetailHeader title="Brand voice" description="Tone, reply length and example wording." status={<BrandVoiceStatus settings={settings}/>}/>
    <div className="space-y-5">
      <section className="ui-panel"><h2 className="p-5 font-semibold">{settings.draft?.voice ? "Saved style draft" : "Current reply style"}</h2><BrandVoiceSummary settings={settings}/></section>
      <section className="ui-panel p-5"><h2 className="mb-4 font-semibold">Edit reply style</h2><ClientVoiceEditor initialVoice={settings.voice} initialVersion={settings.draft?.edit_version ?? 0} embedded/></section>
    </div>
  </AppShell>;
}
