import { query } from "@/lib/db";
import { sendChannelText } from "@/lib/channels/dispatch";
import { decryptChannelCredentials } from "@/lib/channels/credentials";
import { AmbiguousProviderAcceptanceError } from "@/lib/channels/provider-error";
import type { Channel } from "@/lib/types";
import type { OwnerNotificationResult } from "@/lib/escalations";
import { selfServeUIEnabled } from "./settings";
import { getSettings } from "./store";
export async function selfServeAlert(
  escalationId: string,
  clientId: string,
): Promise<OwnerNotificationResult | null> {
  if (!selfServeUIEnabled()) return null;
  const config = await getSettings(clientId);
  if (!config?.enabled) return null;
  const targets = [
    ...(config.alerts.whatsapp_enabled
      ? [{ kind: "whatsapp", destination: config.alerts.whatsapp_number }]
      : []),
    ...(config.alerts.email_enabled
      ? [{ kind: "email", destination: config.alerts.email_address }]
      : []),
  ];
  if (!targets.length)
    return {
      status: "skipped",
      detail: "Both owner alert channels are off. The handover remains open.",
    };
  const escalation = (
    await query<{
      conversation_id: string;
      customer_handle: string;
      channel_kind: string;
      channel_name: string;
    }>(
      "select e.conversation_id,c.customer_handle,ch.kind channel_kind,ch.name channel_name from escalations e join conversations c on c.id=e.conversation_id and c.client_id=e.client_id join channels ch on ch.id=c.channel_id and ch.client_id=c.client_id where e.client_id=$1 and e.id=$2 and e.status in ('open','claimed')",
      [clientId, escalationId],
    )
  ).rows[0];
  if (!escalation)
    return { status: "skipped", detail: "Handover is no longer open." };
  let sent = 0;
  let uncertain = false;
  let failed = false;
  for (const target of targets) {
    const existing = (
      await query<{ status: string }>(
        "select status from selfserve_alert_deliveries where client_id=$1 and escalation_id=$2 and kind=$3",
        [clientId, escalationId, target.kind],
      )
    ).rows[0];
    if (existing?.status === "sent") {
      sent++;
      continue;
    }
    if (existing?.status === "sending" || existing?.status === "uncertain") {
      uncertain = true;
      continue;
    }
    const channel = (
      await query<Channel>(
        `select c.* from channels c join staff_notification_destinations d on d.client_id=c.client_id and d.kind=c.kind::text
    join users u on u.id=d.recipient_user_id and u.client_id=d.client_id and u.role='client'
    where c.client_id=$1 and c.kind::text=$2 and c.status='active' and d.destination=$3 and d.enabled=true and d.verified_at is not null
    and exists(select 1 from staff_permission_grants g where g.client_id=$1 and g.user_id=u.id and g.permission in ('conversation.respond','conversation.release')) limit 1`,
        [clientId, target.kind, target.destination],
      )
    ).rows[0];
    if (!channel) {
      failed = true;
      continue;
    }
    const claim = await query(
      `insert into selfserve_alert_deliveries(client_id,escalation_id,kind,destination,status) values($1,$2,$3,$4,'sending')
   on conflict(client_id,escalation_id,kind) do update set status='sending',destination=excluded.destination,error=null,updated_at=now() where selfserve_alert_deliveries.status='failed' returning id`,
      [clientId, escalationId, target.kind, target.destination],
    );
    if (!claim.rowCount) {
      uncertain = true;
      continue;
    }
    try {
      const customer = (escalation.customer_handle || "a customer")
        .replace(/[\r\n]/g, " ")
        .slice(0, 100);
      const native =
        escalation.channel_kind === "instagram"
          ? "https://www.instagram.com/direct/inbox/"
          : escalation.channel_kind === "whatsapp" &&
              /^\+?\d{7,15}$/.test(customer)
            ? `https://wa.me/${customer.replace("+", "")}`
            : null;
      const text = `Pronto needs your help with ${customer} on ${escalation.channel_name.replace(/[\r\n]/g, " ").slice(0, 100)}. Reply directly in the original ${escalation.channel_kind} conversation.${native ? ` Open: ${native}` : ""}`;
      const delivered = await sendChannelText({
        channelId: decryptChannelCredentials(channel).id,
        clientId,
        externalThreadId: target.destination,
        text,
      });
      await query(
        "update selfserve_alert_deliveries set status='sent',provider_message_id=$4,updated_at=now() where client_id=$1 and escalation_id=$2 and kind=$3",
        [
          clientId,
          escalationId,
          target.kind,
          delivered?.providerMessageId ?? null,
        ],
      );
      sent++;
    } catch (error) {
      const ambiguous = error instanceof AmbiguousProviderAcceptanceError;
      uncertain ||= ambiguous;
      failed ||= !ambiguous;
      await query(
        "update selfserve_alert_deliveries set status=$4,error=$5,updated_at=now() where client_id=$1 and escalation_id=$2 and kind=$3",
        [
          clientId,
          escalationId,
          target.kind,
          ambiguous ? "uncertain" : "failed",
          ambiguous
            ? "Delivery is uncertain; reconcile before retrying."
            : "Delivery failed. Check the channel and verified destination.",
        ],
      );
    }
  }
  return uncertain
    ? {
        status: "failed",
        ambiguous: true,
        detail:
          "Some owner alerts have uncertain delivery; reconcile before retrying.",
      }
    : failed
      ? {
          status: "failed",
          detail:
            "An owner alert could not be delivered. Check its verified destination and channel.",
        }
      : { status: "sent", detail: `${sent} owner alert(s) delivered.` };
}
