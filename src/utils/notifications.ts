type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'IN_APP';

interface NotificationPayload {
  title: string;
  message: string;
  userEmail?: string | null;
  userPhone?: string | null;
  meta?: Record<string, unknown>;
}

interface NotificationDeliveryResult {
  channel: NotificationChannel;
  delivered: boolean;
  reason?: string;
}

const NOTIFICATION_TIMEOUT_MS = Number(process.env.NOTIFICATIONS_TIMEOUT_MS || 10000);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = NOTIFICATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function toJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

async function sendEmailResend(payload: NotificationPayload) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = payload.userEmail;

  if (!apiKey || !from || !to) return false;

  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: payload.title,
      text: `${payload.message}\n\nReferencia: ${toJsonString(payload.meta || {})}`,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  return true;
}

function normalizeWhatsappPhone(phone: string): string {
  const clean = phone.replace(/[\s\-()]/g, '');
  if (clean.startsWith('00')) return `whatsapp:+${clean.slice(2)}`;
  if (clean.startsWith('+')) return `whatsapp:${clean}`;
  if (clean.startsWith('549')) return `whatsapp:+${clean}`;
  if (clean.startsWith('54')) return `whatsapp:+${clean}`;
  if (clean.startsWith('0')) return `whatsapp:+54${clean.slice(1)}`;
  return `whatsapp:+${clean}`;
}

async function sendWhatsappTwilio(payload: NotificationPayload) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
  const toPhone = payload.userPhone;

  if (!accountSid || !authToken || !fromNumber || !toPhone) return false;

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const from = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
  const to = normalizeWhatsappPhone(toPhone);

  const body = new URLSearchParams({
    From: from,
    To: to,
    Body: `${payload.title}\n${payload.message}`,
  }).toString();

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Twilio error ${response.status}: ${responseBody}`);
  }

  return true;
}

async function dispatchToWebhook(channel: NotificationChannel, payload: NotificationPayload) {
  const webhookUrl = process.env.NOTIFICATIONS_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        payload,
        sentAt: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('[notifications] webhook error:', err);
  }
}

export async function sendNotification(
  channels: NotificationChannel[],
  payload: NotificationPayload
) {
  const notificationsEnabled = process.env.NOTIFICATIONS_ENABLED !== 'false';
  if (!notificationsEnabled) {
    console.log('[notifications] disabled by NOTIFICATIONS_ENABLED=false');
    return;
  }

  const results = await Promise.all(
    channels.map(async (channel) => {
      try {
        if (channel === 'EMAIL') {
          const sent = await sendEmailResend(payload);
          if (!sent) {
            console.warn('[notifications:EMAIL] missing RESEND config or recipient');
            return { channel, delivered: false, reason: 'missing_config_or_recipient' } satisfies NotificationDeliveryResult;
          }

          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true } satisfies NotificationDeliveryResult;
        }

        if (channel === 'WHATSAPP') {
          const sent = await sendWhatsappTwilio(payload);
          if (!sent) {
            console.warn('[notifications:WHATSAPP] missing Twilio config or recipient');
            return { channel, delivered: false, reason: 'missing_config_or_recipient' } satisfies NotificationDeliveryResult;
          }

          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true } satisfies NotificationDeliveryResult;
        }

        if (channel === 'IN_APP') {
          console.log('[notifications:IN_APP]', payload.title);
          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true } satisfies NotificationDeliveryResult;
        }
      } catch (err) {
        console.error(`[notifications:${channel}] provider error:`, err);
        return { channel, delivered: false, reason: 'provider_error' } satisfies NotificationDeliveryResult;
      }

      return { channel, delivered: false, reason: 'unsupported_channel' } satisfies NotificationDeliveryResult;
    })
  );

  const delivered = results.filter((r) => r.delivered).length;
  if (delivered === 0) {
    console.warn('[notifications] no channel delivered', {
      title: payload.title,
      channels,
      results,
    });
  }
}
