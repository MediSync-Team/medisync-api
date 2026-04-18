import webpush from 'web-push';
import prisma from '../lib/prisma';

// Configure VAPID once when module loads
const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY  ?? '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? '';
const vapidMailto     = process.env.VAPID_MAILTO       ?? 'mailto:admin@medisync.ar';

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidMailto, vapidPublicKey, vapidPrivateKey);
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  data?: Record<string, unknown>;
}

/**
 * Send a Web Push notification to all subscriptions for a given user.
 * Silently removes stale subscriptions (410 Gone).
 */
export async function sendWebPush(usuarioId: string, payload: PushPayload): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn('[web-push] VAPID keys not configured — skipping push');
    return;
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { usuarioId },
  });

  if (subscriptions.length === 0) return;

  const message = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon ?? '/icon-192.png',
    badge: payload.badge ?? '/badge-72.png',
    tag: payload.tag,
    url: payload.url ?? '/',
    data: payload.data,
  });

  const staleIds: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message,
          { TTL: 86400 }, // 24 hours TTL
        );
      } catch (err: any) {
        // 404 / 410 = subscription expired or unsubscribed
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          staleIds.push(sub.id);
        } else {
          console.error('[web-push] delivery error:', err?.message ?? err);
        }
      }
    }),
  );

  if (staleIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } });
    console.log(`[web-push] removed ${staleIds.length} stale subscription(s) for user ${usuarioId}`);
  }
}

/**
 * Send push to multiple users at once.
 */
export async function sendWebPushToMany(usuarioIds: string[], payload: PushPayload): Promise<void> {
  await Promise.allSettled(usuarioIds.map((id) => sendWebPush(id, payload)));
}

export { vapidPublicKey };
