import { CLINIC_TIME_ZONE } from './clinic-time';

export type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'IN_APP';

export type NotificationEvent =
  | 'TURNO_RESERVADO'
  | 'TURNO_CONFIRMADO'
  | 'TURNO_CANCELADO'
  | 'TURNO_REPROGRAMADO'
  | 'RECORDATORIO_48H'
  | 'RECORDATORIO_24H'
  | 'RECORDATORIO_2H'
  | 'RECETA_EMITIDA'
  | 'LISTA_ESPERA_NOTIFICADA'
  | 'BIENVENIDA'
  | 'PRUEBA'
  | 'INVITACION_CLINICA'
  | 'BOOKING_CONFIRMATION'
  | 'BOOKING_CONFIRMED'
  | 'RECUPERAR_CONTRASENA'
  | 'PAGO_REEMBOLSADO';

export interface NotificationPayload {
  event: NotificationEvent;
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

// ── HTML Email Templates ────────────────────────────────────────────────────

const EMAIL_BRAND_COLOR = '#2563EB';
const EMAIL_SUCCESS_COLOR = '#059669';
const EMAIL_DANGER_COLOR = '#DC2626';
const EMAIL_WARNING_COLOR = '#D97706';

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MediSync</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <!-- Header -->
        <tr>
          <td style="background:${EMAIL_BRAND_COLOR};border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
            <span style="display:inline-block;background:white;border-radius:8px;padding:8px 14px;">
              <span style="font-size:18px;font-weight:800;color:${EMAIL_BRAND_COLOR};letter-spacing:-0.5px;">✚ MediSync</span>
            </span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="background:#FFFFFF;padding:32px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">
            ${content}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F1F5F9;border-radius:0 0 12px 12px;border:1px solid #E2E8F0;border-top:none;padding:20px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#94A3B8;">
              Este mensaje fue enviado automáticamente por MediSync.<br/>
              Si no esperabas este email, podés ignorarlo.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function infoBox(label: string, value: string, color = '#1E293B'): string {
  return `<tr>
    <td style="padding:4px 0;">
      <span style="font-size:12px;color:#64748B;display:block;">${label}</span>
      <span style="font-size:14px;font-weight:600;color:${color};">${value}</span>
    </td>
  </tr>`;
}

function primaryButton(text: string, url?: string): string {
  if (!url) return '';
  return `<div style="text-align:center;margin-top:20px;">
    <a href="${url}" style="display:inline-block;padding:12px 28px;background:${EMAIL_BRAND_COLOR};color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${text}</a>
  </div>`;
}

function buildEmailHtml(payload: NotificationPayload): string {
  const { event, title, message, meta = {} } = payload;

  const iconMap: Record<NotificationEvent, string> = {
    TURNO_RESERVADO: '📅',
    TURNO_CONFIRMADO: '✅',
    TURNO_CANCELADO: '❌',
    TURNO_REPROGRAMADO: '🔄',
    RECORDATORIO_48H: '⏰',
    RECORDATORIO_24H: '⏰',
    RECORDATORIO_2H: '🔔',
    RECETA_EMITIDA: '📋',
    LISTA_ESPERA_NOTIFICADA: '🎉',
    BIENVENIDA: '👋',
    PRUEBA: '🧪',
    INVITACION_CLINICA: '🏥',
    BOOKING_CONFIRMATION: '📧',
    BOOKING_CONFIRMED: '✅',
    RECUPERAR_CONTRASENA: '🔐',
    PAGO_REEMBOLSADO: '💸',
  };

  const accentMap: Record<NotificationEvent, string> = {
    TURNO_RESERVADO: EMAIL_BRAND_COLOR,
    TURNO_CONFIRMADO: EMAIL_SUCCESS_COLOR,
    TURNO_CANCELADO: EMAIL_DANGER_COLOR,
    TURNO_REPROGRAMADO: EMAIL_WARNING_COLOR,
    RECORDATORIO_48H: EMAIL_WARNING_COLOR,
    RECORDATORIO_24H: EMAIL_WARNING_COLOR,
    RECORDATORIO_2H: EMAIL_DANGER_COLOR,
    RECETA_EMITIDA: EMAIL_SUCCESS_COLOR,
    LISTA_ESPERA_NOTIFICADA: EMAIL_SUCCESS_COLOR,
    BIENVENIDA: EMAIL_BRAND_COLOR,
    PRUEBA: EMAIL_BRAND_COLOR,
    INVITACION_CLINICA: EMAIL_BRAND_COLOR,
    BOOKING_CONFIRMATION: EMAIL_BRAND_COLOR,
    BOOKING_CONFIRMED: EMAIL_SUCCESS_COLOR,
    RECUPERAR_CONTRASENA: EMAIL_WARNING_COLOR,
    PAGO_REEMBOLSADO: EMAIL_SUCCESS_COLOR,
  };

  const icon = iconMap[event] ?? '📬';
  const accent = accentMap[event] ?? EMAIL_BRAND_COLOR;

  // Build detail rows from meta fields we know about
  const details: string[] = [];
  if (meta.fechaHora && typeof meta.fechaHora === 'string') {
    const d = new Date(meta.fechaHora);
    details.push(infoBox('Fecha y hora', d.toLocaleString('es-AR', { timeZone: CLINIC_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })));
  }
  if (meta.profesional && typeof meta.profesional === 'string') {
    details.push(infoBox('Profesional', meta.profesional));
  }
  if (meta.especialidad && typeof meta.especialidad === 'string') {
    details.push(infoBox('Especialidad', meta.especialidad));
  }
  if (meta.modalidad && typeof meta.modalidad === 'string') {
    details.push(infoBox('Modalidad', meta.modalidad === 'VIRTUAL' ? '🖥️ Virtual' : '🏥 Presencial'));
  }
  if (meta.paciente && typeof meta.paciente === 'string') {
    details.push(infoBox('Paciente', meta.paciente));
  }
  if (meta.lugarAtencion && typeof meta.lugarAtencion === 'string') {
    details.push(infoBox('Lugar', `📍 ${meta.lugarAtencion}`));
  }
  if (meta.modalidad === 'VIRTUAL') {
    const dashboardUrl = `${process.env.FRONTEND_URL ?? ''}/dashboard`;
    details.push(infoBox('Videoconsulta', `<a href="${dashboardUrl}" style="color:${EMAIL_BRAND_COLOR};">Ingresá a MediSync para unirte</a>`));
  }

  const detailsHtml = details.length
    ? `<table cellpadding="0" cellspacing="0" style="width:100%;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin:20px 0;">
        ${details.join('')}
       </table>`
    : '';

  let ctaHtml = '';
  if (meta.modalidad === 'VIRTUAL') {
    ctaHtml = primaryButton('Ingresar a la videoconsulta', `${process.env.FRONTEND_URL ?? ''}/dashboard`);
  } else if (event === 'RECUPERAR_CONTRASENA' && meta.resetUrl && typeof meta.resetUrl === 'string') {
    ctaHtml = primaryButton('Restablecer contraseña', meta.resetUrl);
  } else if (event === 'BOOKING_CONFIRMATION' && meta.confirmUrl && typeof meta.confirmUrl === 'string') {
    ctaHtml = primaryButton('Confirmar mi turno', meta.confirmUrl);
  } else if (event === 'INVITACION_CLINICA' && meta.acceptUrl && typeof meta.acceptUrl === 'string') {
    ctaHtml = primaryButton('Aceptar invitación', meta.acceptUrl);
  }

  const body = `
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:40px;line-height:1;">${icon}</span>
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1E293B;text-align:center;">${title}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#475569;text-align:center;line-height:1.6;">${message}</p>
    ${detailsHtml}
    ${ctaHtml}
    ${event === 'BIENVENIDA' ? `<div style="margin-top:24px;padding:16px;background:#EFF6FF;border-radius:8px;border-left:4px solid ${EMAIL_BRAND_COLOR};">
      <p style="margin:0;font-size:13px;color:#1E40AF;line-height:1.6;">
        <strong>¿Qué podés hacer con MediSync?</strong><br/>
        📅 Reservar turnos con especialistas al instante<br/>
        💳 Pagar online con Mercado Pago<br/>
        📋 Acceder a tus recetas e indicaciones<br/>
        🏥 Consultas presenciales y virtuales
      </p>
    </div>` : ''}
  `;

  return emailWrapper(body);
}

// ── Resend (email) ─────────────────────────────────────────────────────────

async function sendEmailResend(payload: NotificationPayload) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = payload.userEmail;

  if (!apiKey || !from || !to) return false;

  const htmlBody = buildEmailHtml(payload);
  const textBody = `${payload.title}\n\n${payload.message}`;

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
      html: htmlBody,
      text: textBody,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  return true;
}

// ── Twilio WhatsApp ────────────────────────────────────────────────────────

function normalizeWhatsappPhone(phone: string): string {
  const clean = phone.replace(/[\s\-()]/g, '');
  if (clean.startsWith('00')) return `whatsapp:+${clean.slice(2)}`;
  if (clean.startsWith('+')) {
    // Argentine mobiles need 9 after country code for WhatsApp
    if (clean.startsWith('+54') && clean.length >= 12 && !clean.startsWith('+549')) {
      return `whatsapp:+549${clean.slice(3)}`;
    }
    return `whatsapp:${clean}`;
  }
  if (clean.startsWith('549')) return `whatsapp:+${clean}`;
  if (clean.startsWith('54') && clean.length >= 11) {
    if (!clean.startsWith('549')) {
      return `whatsapp:+549${clean.slice(2)}`;
    }
    return `whatsapp:+${clean}`;
  }
  if (clean.startsWith('0')) return `whatsapp:+54${clean.slice(1)}`;
  return `whatsapp:+${clean}`;
}

function buildWhatsappText(payload: NotificationPayload): string {
  const { title, message, meta = {} } = payload;

  if (payload.event === 'RECORDATORIO_48H') {
    const profesional = typeof meta.profesional === 'string' ? meta.profesional : 'tu profesional';
    let fecha = typeof meta.fechaTexto === 'string' ? meta.fechaTexto : '';

    if (!fecha && typeof meta.fechaHora === 'string') {
      const d = new Date(meta.fechaHora);
      fecha = d.toLocaleString('es-AR', {
        timeZone: CLINIC_TIME_ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    return [
      `Hola, te recordamos tu turno con ${profesional} el ${fecha}.`,
      'Respondé:',
      '1 Confirmar asistencia',
      '2 Reprogramar',
      '3 Cancelar',
      '4 Ver próximos turnos',
    ].join('\n');
  }

  const lines = [`*${title}*`, '', message];

  if (meta.fechaHora && typeof meta.fechaHora === 'string') {
    const d = new Date(meta.fechaHora);
    lines.push('', `📅 *Fecha:* ${d.toLocaleString('es-AR', { timeZone: CLINIC_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`);
  }
  if (meta.profesional && typeof meta.profesional === 'string') {
    lines.push(`👨‍⚕️ *Profesional:* ${meta.profesional}`);
  }
  if (meta.modalidad && typeof meta.modalidad === 'string') {
    lines.push(`🏥 *Modalidad:* ${meta.modalidad === 'VIRTUAL' ? 'Virtual' : 'Presencial'}`);
  }
  if (meta.lugarAtencion && typeof meta.lugarAtencion === 'string') {
    lines.push(`📍 *Lugar:* ${meta.lugarAtencion}`);
  }
  if (meta.modalidad === 'VIRTUAL') {
    lines.push(`🖥️ *Videoconsulta:* Ingresá a MediSync para unirte → ${process.env.FRONTEND_URL ?? ''}/dashboard`);
  }
  lines.push('', '_MediSync — Tu plataforma médica_');
  return lines.join('\n');
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
    Body: buildWhatsappText(payload),
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

// ── Webhook (observabilidad) ────────────────────────────────────────────────

async function dispatchToWebhook(channel: NotificationChannel, payload: NotificationPayload) {
  const webhookUrl = process.env.NOTIFICATIONS_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload, sentAt: new Date().toISOString() }),
    });
  } catch (err) {
    console.error('[notifications] webhook error:', err);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function sendNotification(
  channels: NotificationChannel[],
  payload: NotificationPayload,
) {
  const notificationsEnabled = process.env.NOTIFICATIONS_ENABLED !== 'false';
  if (!notificationsEnabled) {
    console.log('[notifications] disabled — NOTIFICATIONS_ENABLED=false');
    return;
  }

  const results = await Promise.all(
    channels.map(async (channel): Promise<NotificationDeliveryResult> => {
      try {
        if (channel === 'EMAIL') {
          const sent = await sendEmailResend(payload);
          if (!sent) {
            console.warn('[notifications:EMAIL] missing RESEND config or recipient');
            return { channel, delivered: false, reason: 'missing_config_or_recipient' };
          }
          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true };
        }

        if (channel === 'WHATSAPP') {
          const sent = await sendWhatsappTwilio(payload);
          if (!sent) {
            console.warn('[notifications:WHATSAPP] missing Twilio config or recipient');
            return { channel, delivered: false, reason: 'missing_config_or_recipient' };
          }
          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true };
        }

        if (channel === 'IN_APP') {
          console.log('[notifications:IN_APP]', payload.title);
          await dispatchToWebhook(channel, payload);
          return { channel, delivered: true };
        }
      } catch (err) {
        console.error(`[notifications:${channel}] provider error:`, err);
        return { channel, delivered: false, reason: 'provider_error' };
      }
      return { channel, delivered: false, reason: 'unsupported_channel' };
    }),
  );

  const delivered = results.filter((r) => r.delivered).length;
  if (delivered === 0) {
    console.warn('[notifications] no channel delivered', { title: payload.title, channels, results });
  }
}

/**
 * Resolves which channels to use based on user preferences.
 * prefs: { notifEmail, notifWhatsapp }
 */
export function resolveChannels(prefs: {
  notifEmail: boolean;
  notifWhatsapp: boolean;
}): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (prefs.notifEmail) channels.push('EMAIL');
  if (prefs.notifWhatsapp) channels.push('WHATSAPP');
  if (channels.length === 0) channels.push('IN_APP'); // fallback
  return channels;
}
