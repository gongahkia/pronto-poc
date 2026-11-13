import type { Conversation } from "@/lib/types";
import type { EscalationPolicy } from "@/lib/staff-configuration";
import { Badge } from "@/components/badge";

export function ConversationClassificationPanel({ conversation, canRespond, policy }: {
  conversation: Conversation; canRespond: boolean; policy: EscalationPolicy | null;
}) {
  const resolved = conversation.status === "closed";
  const teamOwned = conversation.status === "escalated";
  return <section className="ui-panel p-4" aria-label="Conversation status">
    <h2 className="font-semibold">Conversation status</h2>
    <div className="my-3 flex flex-wrap gap-2">
      <Badge tone={resolved ? "green" : teamOwned ? "amber" : "neutral"}>
        {resolved ? "Resolved" : teamOwned ? "Your team is handling this" : "Assistant is handling this"}
      </Badge>
      {!teamOwned && !resolved && conversation.owner_action_required && <Badge tone="amber">Review requested</Badge>}
    </div>
    <p className="text-sm leading-6 text-muted">{resolved ? "This conversation has been resolved."
      : teamOwned ? "A team member needs to review and reply. The assistant is paused."
      : conversation.owner_action_required ? "An unanswered question needs your team. Pronto can answer other supported questions until you take over."
      : "No team reply is needed. The assistant will continue answering."}</p>
    {policy?.targetMinutes != null && <p className="mt-2 text-xs text-muted">Team response target: {policy.targetMinutes} minutes.</p>}
    {canRespond && !resolved && <>
      <form action={`/api/client/conversations/${conversation.id}`} method="post" className="mt-4 space-y-3">
        <input type="hidden" name="action" value="classify"/>
        <label className="block text-sm">Priority<select aria-label="Conversation urgency" name="urgency" className="ui-input mt-1 w-full px-3 py-2 text-sm" defaultValue={conversation.urgency ?? "long_term"}>
          <option value="short_term">Short-term</option><option value="long_term">Long-term</option></select></label>
        <label className="block text-sm">Needs your review<select aria-label="Owner action required" name="ownerActionRequired" className="ui-input mt-1 w-full px-3 py-2 text-sm" defaultValue={String(conversation.owner_action_required ?? false)}>
          <option value="true">Yes</option><option value="false">No</option></select></label>
        <button className="ui-button px-3 py-2 text-sm">Save changes</button>
      </form>
      {!teamOwned && <form action={`/api/client/conversations/${conversation.id}`} method="post" className="mt-3">
        <input type="hidden" name="action" value="takeover"/>
        <button className="ui-primary-button w-full px-3 py-2 text-sm">Take over and reply</button></form>}
    </>}
  </section>;
}
