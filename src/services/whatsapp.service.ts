import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { getAvailableSlotsForProfessional } from './slot-availability.service';
import { cambiarEstadoTurno } from './turnos/estado.service';
import { reprogramarTurno } from './turnos/reschedule.service';
import {
  addDaysToClinicDate,
  clinicDateTimeToUtcDate,
  formatClinicDateKey,
  formatClinicDateTimeEs,
} from '../utils/clinic-time';

const MAIN_MENU = 'Hola, con que puedo ayudarte:\n1 Ver proximos turnos';
const SESSION_TTL_MS = 30 * 60 * 1000;

type WhatsappSessionData = {
  slots?: Array<{ fechaHora: string; label: string }>;
};

function stripWhatsappPrefix(value: string): string {
  return value.replace(/^whatsapp:/i, '').trim();
}

function phoneDigits(value: string): string {
  return stripWhatsappPrefix(value).replace(/[^\d]/g, '');
}

function phoneVariants(from: string): string[] {
  const bare = stripWhatsappPrefix(from);
  const digits = phoneDigits(from);
  const variants = new Set<string>([
    from,
    bare,
    digits,
    `+${digits}`,
    `whatsapp:+${digits}`,
    `whatsapp:${bare}`,
  ]);
  // Handle Argentine format: +54911... is sent by WhatsApp, but may be stored as +5411...
  if (digits.startsWith('549') && digits[3] !== '9') {
    const without9 = `+${digits.slice(0, 2)}${digits.slice(3)}`;
    variants.add(without9);
    variants.add(without9.replace('+', ''));
    variants.add(`whatsapp:${without9}`);
  }
  return Array.from(variants).filter(Boolean);
}

function normalizeSessionPhone(from: string): string {
  const digits = phoneDigits(from);
  // Argentine mobile numbers: add 9 after country code to match WhatsApp format
  if (digits.startsWith('54') && digits.length >= 11 && !digits.startsWith('549')) {
    return `whatsapp:+549${digits.slice(2)}`;
  }
  return `whatsapp:+${digits}`;
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS);
}

function parseSessionData(data: Prisma.JsonValue | null | undefined): WhatsappSessionData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as WhatsappSessionData;
}

export function buildWhatsappMainMenu(): string {
  return MAIN_MENU;
}

export function buildTwimlMessage(message: string): string {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

export function validateTwilioSignature(params: {
  url: string;
  body: Record<string, unknown>;
  signature?: string;
}): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !params.signature) return process.env.NODE_ENV !== 'production';

  const sortedKeys = Object.keys(params.body).sort();
  const data = sortedKeys.reduce((acc, key) => `${acc}${key}${String(params.body[key] ?? '')}`, params.url);
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
  } catch {
    return false;
  }
}

async function findPacienteByWhatsapp(from: string) {
  const variants = phoneVariants(from);
  return prisma.paciente.findFirst({
    where: { telefono: { in: variants } },
    include: { usuario: { select: { id: true } } },
  });
}

async function getUpcomingTurnosForPaciente(pacienteId: string, take = 5) {
  return prisma.turno.findMany({
    where: {
      pacienteId,
      fechaHora: { gte: new Date() },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: {
      profesional: { include: { especialidad: true } },
    },
    orderBy: { fechaHora: 'asc' },
    take,
  });
}

function formatTurnoLine(index: number, turno: Awaited<ReturnType<typeof getUpcomingTurnosForPaciente>>[number]) {
  return `${index}. ${formatClinicDateTimeEs(turno.fechaHora)} con Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`;
}

async function getOrCreateSession(phone: string, pacienteId?: string | null) {
  let existing = await prisma.whatsappSession.findUnique({ where: { phone } });
  if (existing && existing.expiresAt > new Date()) return existing;

  // Try Argentine variant (without the 9) — the reminder session may have been
  // stored under +5411... while WhatsApp sends +54911...
  if (phone.startsWith('whatsapp:+549')) {
    const without9 = `whatsapp:+54${phone.slice(11)}`;
    if (without9 !== phone) {
      existing = await prisma.whatsappSession.findUnique({ where: { phone: without9 } });
      if (existing && existing.expiresAt > new Date()) return existing;
    }
  }

  return prisma.whatsappSession.upsert({
    where: { phone },
    create: {
      phone,
      pacienteId,
      estado: 'MENU',
      expiresAt: sessionExpiresAt(),
    },
    update: {
      pacienteId,
      turnoId: null,
      estado: 'MENU',
      data: Prisma.JsonNull,
      expiresAt: sessionExpiresAt(),
    },
  });
}

async function showUpcomingTurnos(pacienteId: string) {
  const turnos = await getUpcomingTurnosForPaciente(pacienteId);
  if (turnos.length === 0) {
    return 'No tenes turnos proximos registrados.\n\n' + MAIN_MENU;
  }

  return [
    'Tus proximos turnos:',
    ...turnos.map((turno, index) => formatTurnoLine(index + 1, turno)),
  ].join('\n');
}

async function confirmAttendance(turnoId: string, pacienteId: string) {
  const turno = await prisma.turno.findFirst({
    where: {
      id: turnoId,
      pacienteId,
      fechaHora: { gte: new Date() },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: { profesional: true },
  });

  if (!turno) return 'No encontre un turno vigente para confirmar.\n\n' + MAIN_MENU;

  await prisma.turno.update({
    where: { id: turno.id },
    data: { asistenciaConfirmadaAt: new Date() },
  });

  return `Asistencia confirmada para tu turno del ${formatClinicDateTimeEs(turno.fechaHora)} con Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}.`;
}

async function cancelTurno(turnoId: string, paciente: NonNullable<Awaited<ReturnType<typeof findPacienteByWhatsapp>>>) {
  try {
    await cambiarEstadoTurno({
      turnoId,
      userId: paciente.usuarioId,
      estado: 'CANCELADO',
      notasCancelacion: 'Cancelado por WhatsApp',
    });
    return 'Tu turno fue cancelado correctamente.';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo cancelar el turno.';
    return `${message}\n\n${MAIN_MENU}`;
  }
}

async function buildRescheduleSlots(turnoId: string, pacienteId: string) {
  const turno = await prisma.turno.findFirst({
    where: {
      id: turnoId,
      pacienteId,
      fechaHora: { gte: new Date() },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
  });

  if (!turno) return { message: 'No encontre un turno vigente para reprogramar.\n\n' + MAIN_MENU, slots: [] };

  const slots: Array<{ fechaHora: string; label: string }> = [];
  const today = formatClinicDateKey(new Date());

  for (let offset = 1; offset <= 14 && slots.length < 5; offset++) {
    const fecha = addDaysToClinicDate(today, offset);
    const available = await getAvailableSlotsForProfessional({
      profesionalId: turno.profesionalId,
      fecha,
      modalidad: turno.modalidad,
      duracionMin: turno.duracionMin,
    });

    for (const slot of available) {
      if (!slot.disponible) continue;
      const fechaHora = clinicDateTimeToUtcDate(fecha, slot.hora);
      if (fechaHora <= new Date()) continue;
      slots.push({
        fechaHora: fechaHora.toISOString(),
        label: formatClinicDateTimeEs(fechaHora),
      });
      if (slots.length >= 5) break;
    }
  }

  if (slots.length === 0) {
    return { message: 'No encontre horarios disponibles para reprogramar en los proximos dias.\n\n' + MAIN_MENU, slots };
  }

  return {
    message: [
      'Estos son los proximos horarios disponibles. Responde con el numero que prefieras:',
      ...slots.map((slot, index) => `${index + 1}. ${slot.label}`),
    ].join('\n'),
    slots,
  };
}

async function chooseRescheduleSlot(params: {
  selected: number;
  session: Awaited<ReturnType<typeof getOrCreateSession>>;
  paciente: NonNullable<Awaited<ReturnType<typeof findPacienteByWhatsapp>>>;
}) {
  const data = parseSessionData(params.session.data);
  const slot = data.slots?.[params.selected - 1];
  if (!slot || !params.session.turnoId) {
    return 'No pude reconocer ese horario. Pedi reprogramar nuevamente.\n\n' + MAIN_MENU;
  }

  try {
    const turno = await reprogramarTurno({
      turnoId: params.session.turnoId,
      userId: params.paciente.usuarioId,
      fechaHora: slot.fechaHora,
    });

    await prisma.whatsappSession.update({
      where: { phone: params.session.phone },
      data: { estado: 'MENU', data: Prisma.JsonNull, expiresAt: sessionExpiresAt() },
    });

    return `Tu turno fue reprogramado para el ${formatClinicDateTimeEs(turno.fechaHora)}.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo reprogramar el turno.';
    return `${message}\n\n${MAIN_MENU}`;
  }
}

export async function prepareWhatsappReminderSession(params: {
  phone: string;
  pacienteId: string;
  turnoId: string;
}) {
  const phone = normalizeSessionPhone(params.phone);
  await prisma.whatsappSession.upsert({
    where: { phone },
    create: {
      phone,
      pacienteId: params.pacienteId,
      turnoId: params.turnoId,
      estado: 'REMINDER_ACTIONS',
      expiresAt: sessionExpiresAt(),
    },
    update: {
      pacienteId: params.pacienteId,
      turnoId: params.turnoId,
      estado: 'REMINDER_ACTIONS',
      data: Prisma.JsonNull,
      expiresAt: sessionExpiresAt(),
    },
  });
}

export async function handleIncomingWhatsappMessage(params: {
  from: string;
  body: string;
}) {
  const phone = normalizeSessionPhone(params.from);
  const text = params.body.trim().toLowerCase();
  const paciente = await findPacienteByWhatsapp(params.from);

  if (!paciente) {
    return MAIN_MENU;
  }

  const session = await getOrCreateSession(phone, paciente.id);
  const selected = Number(text);

  if (session.estado === 'SELECTING_RESCHEDULE_SLOT' && Number.isInteger(selected)) {
    return chooseRescheduleSlot({ selected, session, paciente });
  }

  // If session has no turnoId but user is acting on a reminder option
  // (2/reprogramar, 3/cancelar), recover it from the latest active turno.
  // Option 1 is NOT recovered here because it's ambiguous (confirm vs show).
  let turnoId = session.turnoId;
  if (!turnoId && session.estado !== 'REMINDER_ACTIONS' && (text === '2' || text === '3')) {
    const latest = await prisma.turno.findFirst({
      where: {
        pacienteId: paciente.id,
        fechaHora: { gte: new Date() },
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      orderBy: { fechaHora: 'asc' },
      select: { id: true },
    });
    if (latest) {
      turnoId = latest.id;
      await prisma.whatsappSession.update({
        where: { phone },
        data: { turnoId, estado: 'REMINDER_ACTIONS', expiresAt: sessionExpiresAt() },
      });
    }
  }

  if ((text === '1' || text.includes('confirmar')) && session.estado === 'REMINDER_ACTIONS' && turnoId) {
    const message = await confirmAttendance(turnoId, paciente.id);
    await prisma.whatsappSession.update({
      where: { phone },
      data: { estado: 'MENU', turnoId: null, data: Prisma.JsonNull, expiresAt: sessionExpiresAt() },
    });
    return message;
  }

  if ((text === '2' || text.includes('reprogramar')) && turnoId) {
    const { message, slots } = await buildRescheduleSlots(turnoId, paciente.id);
    await prisma.whatsappSession.update({
      where: { phone },
      data: {
        estado: slots.length > 0 ? 'SELECTING_RESCHEDULE_SLOT' : 'MENU',
        data: slots.length > 0 ? { slots } : Prisma.JsonNull,
        expiresAt: sessionExpiresAt(),
      },
    });
    return message;
  }

  if ((text === '3' || text.includes('cancelar')) && turnoId) {
    const message = await cancelTurno(turnoId, paciente);
    await prisma.whatsappSession.update({
      where: { phone },
      data: { estado: 'MENU', turnoId: null, data: Prisma.JsonNull, expiresAt: sessionExpiresAt() },
    });
    return message;
  }

  if (text === '1' || text === '4' || text.includes('turno')) {
    return showUpcomingTurnos(paciente.id);
  }

  return MAIN_MENU;
}
