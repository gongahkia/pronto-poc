import { requireUser } from "@/lib/auth";
import { getChannels, getClient } from "@/lib/dashboard";
import { listChannelDrafts } from "@/lib/client-channel-drafts";
import { AppShell } from "@/components/shell";
import { BusinessKnowledgeDetailHeader } from "@/components/business-knowledge-card";
import { BusinessChannelsDetail, type KnowledgeChannelParams } from "@/components/business-channels-card";

export default async function ChannelsPage({ searchParams }: { searchParams?: Promise<KnowledgeChannelParams> }) {
  const user = await requireUser("client");
  if (!user.clientId) throw new Error("Business assignment required.");
  const [client, channels, drafts, params] = await Promise.all([
    getClient(user.clientId), getChannels(user.clientId), listChannelDrafts(user.clientId), searchParams ?? Promise.resolve({} as KnowledgeChannelParams),
  ]);
  if (!client) throw new Error("Business not found.");
  return <AppShell user={user} active="client" clientActive="knowledge" workspaceName={client.name} workspaceProfile={client.business_profile}>
    <BusinessKnowledgeDetailHeader title="Channels" description="Where customers can reach your business."/>
    <BusinessChannelsDetail channels={channels} drafts={drafts} params={params}/>
  </AppShell>;
}
