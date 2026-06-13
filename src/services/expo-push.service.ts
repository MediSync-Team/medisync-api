import { Expo } from 'expo-server-sdk';
import prisma from '../lib/prisma';

const expo = new Expo();

export interface ExpoPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendExpoPushToUser(usuarioId: string, payload: ExpoPushPayload): Promise<void> {
  const devices = await prisma.pushDevice.findMany({ where: { usuarioId } });
  if (devices.length === 0) return;

  const messages = devices
    .filter((device) => Expo.isExpoPushToken(device.token))
    .map((device) => ({
      to: device.token,
      sound: 'default' as const,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
    }));

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('[expo-push] delivery error:', err);
    }
  }
}
