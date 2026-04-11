type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'IN_APP';

interface NotificationPayload {
  title: string;
  message: string;
  userEmail?: string | null;
  userPhone?: string | null;
  meta?: Record<string, unknown>;
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

  const response = await fetch('https://api.resend.com/emails', {
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
  if (clean.startsWith('+')) return `whatsapp:${clean}`;
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

  const response = await fetch(endpoint, {
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
    await fetch(webhookUrl, {
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
  await Promise.all(
    channels.map(async (channel) => {
      try {
        if (channel === 'EMAIL') {
          const sent = await sendEmailResend(payload);
          if (!sent) {
            console.warn('[notifications:EMAIL] missing RESEND config or recipient');
          }
        }

        if (channel === 'WHATSAPP') {
          const sent = await sendWhatsappTwilio(payload);
          if (!sent) {
            console.warn('[notifications:WHATSAPP] missing Twilio config or recipient');
          }
        }

        if (channel === 'IN_APP') {
          console.log('[notifications:IN_APP]', payload.title);
        }
      } catch (err) {
        console.error(`[notifications:${channel}] provider error:`, err);
      }

      await dispatchToWebhook(channel, payload);
    })
  );
}
