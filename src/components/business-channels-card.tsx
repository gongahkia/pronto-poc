import Image from "next/image";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/badge";
import { channelDefinition, channelDefinitions } from "@/lib/channels/catalog";
import { decryptChannelCredentials } from "@/lib/channels/credentials";
import { channelSetupFields, type ChannelDraft } from "@/lib/client-channel-drafts";
import { appBaseUrl } from "@/lib/env";
import type { Channel } from "@/lib/types";

export type KnowledgeChannelParams = { channel?: string; saved?: string; checked?: string; channelPublished?: string; channelError?: string };
export function BusinessChannelsDetail({ channels, drafts, params }: {
  channels: Channel[]; drafts: ChannelDraft[]; params: KnowledgeChannelParams;
}) {
  const selected = channels.find(channel => channel.id === params.channel) ?? channels.find(channel => channel.kind !== "console") ?? channels[0];
  const draft = drafts.find(item => item.channel_id === selected?.id);
  const exposed = draft ? decryptChannelCredentials({ ...draft, credentials: {} }) : null;
  const settings: Record<string, unknown> = exposed?.settings ?? selected?.settings ?? {};
  const credentials: Record<string, unknown> = exposed?.credentials ?? selected?.credentials ?? {};
  return <div className="grid items-start gap-5 lg:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)]">
    <section className="ui-panel overflow-hidden"><h2 className="border-b border-line p-5 font-semibold">Customer channels</h2>
      <ChannelList channels={channels} drafts={drafts} selectedId={selected?.id}/>
    </section>
    <section className="ui-panel overflow-hidden"><h2 className="border-b border-line p-5 font-semibold">Connection settings</h2>
      <div className="space-y-4 p-5">
        {params.channelError && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">{params.channelError}</p>}
        {params.saved && <p role="status" className="text-sm text-success">Connection settings saved as a draft.</p>}
        {params.checked && <p role="status" className="text-sm text-muted">Connection check: {params.checked}.</p>}
        {params.channelPublished && <p role="status" className="text-sm text-success">Channel changes are live.</p>}
        {selected && <div>
          <h3 className="mb-3 font-medium">{channelDisplayName(selected)}</h3>
          <form key={selected.id} action={`/api/client/channels/${selected.id}`} method="post" className="space-y-3">
            <input type="hidden" name="action" value="save"/>
            <label className="block text-sm">Desired status<select name="status" defaultValue={draft?.status ?? selected.status} className="ui-input mt-1 w-full px-3 py-2">
              <option value="draft">Draft</option><option value="active">Active</option><option value="disabled">Disabled</option>
            </select></label>
            <label className="block text-sm">External ID<input name="externalId" defaultValue={draft?.external_id ?? selected.external_id ?? ""} className="ui-input mt-1 w-full px-3 py-2"/></label>
            {channelSetupFields[selected.kind].map(field => {
              const igMode = settings.authMode ?? "facebook_login";
              if (selected.kind === "instagram" && ((igMode !== "facebook_login" && ["pageAccessToken", "pageId"].includes(field.name)) ||
                (igMode !== "instagram_login" && ["instagramAccessToken", "tokenExpiresAt"].includes(field.name)) ||
                (igMode !== "unified_login" && ["accessToken", "configId", "businessId"].includes(field.name)))) return null;
              const source = field.scope === "settings" ? settings : credentials;
              return <label key={`${field.scope}.${field.name}`} className="block text-sm">{field.label}
                {field.options ? <select name={`${field.scope}.${field.name}`} defaultValue={String(source[field.name] ?? field.options[0])} className="ui-input mt-1 w-full px-3 py-2">
                  {field.options.map(option => <option key={option} value={option}>{option}</option>)}</select>
                  : <input name={`${field.scope}.${field.name}`} type={field.secret ? "password" : "text"} autoComplete="off"
                    defaultValue={field.secret ? "" : String(source[field.name] ?? "")} placeholder={field.secret && source[field.name] ? "Saved securely · leave blank to keep" : ""}
                    className="ui-input mt-1 w-full px-3 py-2"/>}
              </label>;
            })}
            <button className="ui-primary-button px-4 py-2 text-sm">Save draft settings</button>
          </form>
          {selected.kind === "instagram" && settings.authMode !== "unified_login" && <form action={`/api/client/channels/${selected.id}/instagram-login`} method="post" className="mt-3">
            <button className="ui-button px-3 py-2 text-sm">Connect with Instagram Login</button></form>}
          <details className="my-4 text-sm"><summary className="cursor-pointer text-muted">Webhook details</summary>
            <code className="mt-2 block break-all text-xs">{`${appBaseUrl()}/api/webhooks/${selected.kind}/${selected.id}`}</code></details>
          <div className="flex flex-wrap items-center gap-2"><form action={`/api/client/channels/${selected.id}`} method="post">
            <input type="hidden" name="action" value="check"/><button disabled={!draft} className="ui-button px-3 py-2 text-sm">Check connection</button></form>
            {draft && <Badge tone={draft.health_status === "healthy" ? "green" : "amber"}>{draft.health_status ?? "Not checked"}</Badge>}</div>
          {draft?.health_detail && <p className="mt-2 text-sm text-muted">{draft.health_detail}</p>}
          <p className="mt-3 text-xs leading-5 text-muted">Connection changes need business approval and Pronto activation.</p>
        </div>}
        <details className="border-t border-line pt-3"><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Plus size={16} aria-hidden="true"/>Add a channel</summary>
          <form action="/api/client/channels" method="post" className="mt-3 space-y-3">
            <label className="block text-sm">Platform<select name="kind" className="ui-input mt-1 w-full px-3 py-2">
              {channelDefinitions.map(channel => <option key={channel.kind} value={channel.kind}>{channel.label}</option>)}</select></label>
            <label className="block text-sm">Name<input name="name" required maxLength={80} className="ui-input mt-1 w-full px-3 py-2" placeholder="Customer support"/></label>
            <button className="ui-button px-3 py-2 text-sm">Add channel</button>
          </form>
        </details>
      </div>
    </section>
  </div>;
}


function ChannelList({ channels, drafts, selectedId }: { channels: Channel[]; drafts: ChannelDraft[]; selectedId?: string }) {
  return channels.length ? <ul className="divide-y divide-line">{channels.map(channel => <li key={channel.id}>
    <Link href={`/client/knowledge/channels?channel=${encodeURIComponent(channel.id)}`}
      aria-current={selectedId === channel.id ? "page" : undefined}
      className={`flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-hover ${selectedId === channel.id ? "bg-surface" : ""}`}>
      <ChannelRow channel={channel} pending={drafts.some(draft => draft.channel_id === channel.id)}/>
    </Link></li>)}</ul> : <p className="p-5 text-sm text-muted">No customer channels added.</p>;
}

function channelDisplayName(channel: Channel) {
  return channel.kind === "console" ? "Customer chat" : channel.name.replace(/^Demo\s+/i, "").replace(/\s*\(draft\)$/i, "");
}

function ChannelRow({ channel, pending }: { channel: Channel; pending: boolean }) {
  const label = channelDisplayName(channel);
  return <><Image src={channelDefinition(channel.kind).iconPath} alt="" width={20} height={20}/>
    <span className="min-w-0 flex-1"><span className="block truncate">{label}</span>
      {channel.kind !== "console" && label !== channelDefinition(channel.kind).label && <span className="mt-0.5 block text-xs text-muted">{channelDefinition(channel.kind).label}</span>}</span>
    <Badge tone={pending ? "amber" : channel.status === "active" ? "green" : "neutral"}>{pending ? "Unpublished draft" : channel.status === "active" ? "Active" : channel.status === "draft" ? "Setup needed" : "Disabled"}</Badge></>;
}
