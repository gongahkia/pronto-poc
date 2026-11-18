import { query, type Queryable } from "@/lib/db";
import { logWarn } from "@/lib/logger";
import { decryptChannelCredentials, usesLegacyPlaintextCredentials } from "@/lib/channels/credentials";
import { recordOutboundHealth } from "@/lib/channels/health";
import { ChannelPolicyError } from "@/lib/channels/provider-error";
import {
  assertChannelSendAllowed,
  type ChannelSendPolicy,
} from "@/lib/channels/policy";
import { sendTelegramText } from "@/lib/channels/telegram";
import { sendWhatsAppText } from "@/lib/channels/whatsapp";
import { sendMessengerText } from "@/lib/channels/messenger";
import { sendInstagramText } from "@/lib/channels/instagram";
import { lookupReplyThreadingHints, sendEmail } from "@/lib/channels/email";
import type { Channel } from "@/lib/types";
import { assertCustomerDemoEnabled, isCustomerDemoChannel } from "@/lib/customer-demo-boundary";
import { protectedDemoDeployment } from "@/lib/deployment-profile";

export async function sendChannelText(input: {
  channelId: string;
  clientId?: string;
  externalThreadId: string;
  text: string;
  policy?: ChannelSendPolicy;
}, transactionDb?: Queryable): Promise<{ providerMessageId?: string }> {
  const db = transactionDb ?? { query };
  const channelResult = await db.query<Channel>(
    input.clientId
      ? "select * from channels where id = $1 and client_id = $2"
      : "select * from channels where id = $1",
    input.clientId ? [input.channelId, input.clientId] : [input.channelId],
  );
  const channel = channelResult.rows[0]
    ? decryptChannelCredentials(channelResult.rows[0])
    : undefined;
  if (!channel) {
    throw new Error(`Channel not found: ${input.channelId}`);
  }
  // the outbox records health after releasing its ownership transaction.
  const recordHealth = async (error?: unknown) => {
    if (!transactionDb) await safeRecordOutboundHealth(input.channelId, channel.client_id, error);
  };
  if (channel.status !== "active") {
    throw new Error("Channel is disabled or inactive; outbound send blocked.");
  }
  if (protectedDemoDeployment() && !isCustomerDemoChannel(channel))
    throw new ChannelPolicyError("Protected demo delivery permits only the synthetic console channel.");
  if (process.env.PRONTO_DEMO_ONLY_DELIVERY === "1" && channel.kind !== "console" &&
      !(channel.kind === "email" && channel.credentials.provider === "local_smtp"))
    throw new ChannelPolicyError("External provider delivery is disabled in the customer-demo sandbox.");
  if (["whatsapp", "instagram", "messenger", "email"].includes(channel.kind) &&
      usesLegacyPlaintextCredentials(channelResult.rows[0])) {
    throw new Error("Meta channel credentials must be encrypted before activation.");
  }

  if (channel.kind === "console") {
    await assertCustomerDemoEnabled(db);
    if (!isCustomerDemoChannel(channel)) throw new ChannelPolicyError("Unknown simulator channel.");
    const session = await db.query<{ id: string }>(`select s.id from customer_demo_sessions s
      join conversations c on c.id=s.conversation_id and c.client_id=s.client_id
      where s.client_id=$1 and c.channel_id=$2 and c.external_thread_id=$3`,
      [channel.client_id, channel.id, input.externalThreadId]);
    if (!session.rows[0]) throw new ChannelPolicyError("Simulator session not found.");
    // Delivery is the existing durable outbox becoming visible to authenticated
    // polling. No provider function, network request or Instagram account is used.
    return {};
  }
  assertChannelSendAllowed(channel, input.policy);

  try {
    if (channel.kind === "whatsapp") {
      const template = input.policy?.whatsappTemplateName && input.policy.whatsappTemplateApproved === true
        ? { name: input.policy.whatsappTemplateName,
            languageCode: input.policy.whatsappTemplateLanguage ?? "en_US" } : undefined;
      if (!template && !(await hasRecentCustomerMessage(channel, input.externalThreadId, db))) {
        throw new ChannelPolicyError("WhatsApp text reply is outside the customer service window.");
      }
      const providerMessageId = await sendWhatsAppText({ channel,
        externalThreadId: input.externalThreadId, text: input.text, template });
      await recordHealth();
      return { providerMessageId };
    }

    if (channel.kind === "telegram") {
      await sendTelegramText({ channel, externalThreadId: input.externalThreadId, text: input.text });
      await recordHealth();
      return {};
    }

    if (channel.kind === "messenger") {
      if (!(await hasRecentCustomerMessage(channel, input.externalThreadId, db))) {
        throw new ChannelPolicyError("Messenger reply requires a recent customer-initiated conversation.");
      }
      const providerMessageId = await sendMessengerText({ channel, externalThreadId: input.externalThreadId, text: input.text });
      await recordHealth();
      return { providerMessageId };
    }

    if (channel.kind === "instagram") {
      if (!(await hasRecentCustomerMessage(channel, input.externalThreadId, db))) {
        throw new ChannelPolicyError("Instagram reply requires a recent customer-initiated conversation.");
      }
      const providerMessageId = await sendInstagramText({ channel,
        externalThreadId: input.externalThreadId, text: input.text });
      await recordHealth();
      return { providerMessageId };
    }

    if (channel.kind === "email") {
      const threading = await lookupReplyThreadingHints({
        channelId: channel.id,
        clientId: channel.client_id,
        externalThreadId: input.externalThreadId,
      }, db);
      const subjectSetting =
        (channel.settings.defaultSubject as string | undefined) ?? "your inquiry";
      const subject = threading.subject ?? subjectSetting;
      const { messageId } = await sendEmail({
        channel,
        to: threading.to,
        subject,
        text: input.text,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
      }, db);
      await db.query(
        `
          update messages
          set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{outgoingMessageId}', to_jsonb($4::text), true)
          where id = (
            select m.id
            from messages m
            join conversations c on c.id = m.conversation_id
            where c.channel_id = $1
              and c.external_thread_id = $2
              and m.client_id = $3
              and m.sender_role in ('agent', 'operator')
            order by m.created_at desc
            limit 1
          )
        `,
        [channel.id, input.externalThreadId, channel.client_id, messageId],
      );
      await recordHealth();
      return { providerMessageId: messageId };
    }
    throw new ChannelPolicyError("Unsupported outbound channel kind.");
  } catch (error) {
    await recordHealth(error);
    throw error;
  }
}

async function safeRecordOutboundHealth(channelId: string, clientId: string, error?: unknown): Promise<void> {
  try {
    await recordOutboundHealth(channelId, clientId, error);
  } catch (recordingError) {
    logWarn("channel.health_record_failed", { channelId, clientId, error: recordingError });
  }
}

async function hasRecentCustomerMessage(channel: Channel, externalThreadId: string, db: Queryable): Promise<boolean> {
  const recent = await db.query<{ created_at: Date; metadata: Record<string, unknown> }>(
    `select m.created_at, m.metadata from messages m join conversations c on c.id = m.conversation_id
     where m.client_id = $1 and m.channel_id = $2 and c.external_thread_id = $3
       and c.client_id = $1 and m.sender_role = 'customer'
     order by m.created_at desc limit 1`,
    [channel.client_id, channel.id, externalThreadId],
  );
  const occurredAt = recent.rows[0]?.metadata.providerOccurredAt;
  // Meta's customer window is measured from the provider event, not when a
  // delayed or replayed webhook happened to reach our database.
  const age = typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt))
    ? Date.now() - Date.parse(occurredAt) : Infinity;
  return age >= 0 && age < 24 * 60 * 60 * 1000;
}
