import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { sendNotification } from '../../utils/notifications';
import { resolveWaitlistForBooking } from '../waitlist.service';
import {
  DEFAULT_APPOINTMENT_DURATION_MIN,
  SLOT_GRID_STEP_MIN,
  findMatchingAvailability,
  hasAppointmentConflict,
  hasBlockConflict,
} from '../../utils/appointment-conflicts';
import { acquireAppointmentDayLock } from '../../utils/appointment-locks';
import {
  formatClinicDateTimeEs,
  getClinicDateTimeParts,
  getClinicDateOnlyUtc,
  getClinicDayBoundsForInstant,
  getClinicMonthBounds,
} from '../../utils/clinic-time';
import { notifyTurnoUser } from './turno-helpers';

const FREE_PLAN_MONTHLY_TURNO_LIMIT = 20;

/**
 * Resolve the appointment duration from a chosen TipoConsulta. Validates that the
 * type belongs to the professional and is active. Returns the default 30 min when
 * no type is supplied (back-compat).
 */
async function resolveDuracionMin(profesionalId: string, tipoConsultaId?: string | null): Promise<number> {
  if (!tipoConsultaId) return DEFAULT_APPOINTMENT_DURATION_MIN;
  const tipo = await prisma.tipoConsulta.findFirst({
    where: { id: tipoConsultaId, profesionalId, activo: true },
  });
  if (!tipo) {
    throw new AppError(400, 'TIPO_CONSULTA_INVALIDO', 'El tipo de consulta seleccionado no es válido');
  }
  return tipo.duracionMin;
}

export interface ReservarTurnoInput {
  /** Authenticated paciente's usuario id, or `null` for a guest booking. */
  userId: string | null;
  profesionalId: string;
  fechaHora: string;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
  tipoConsultaId?: string | null;
  guestEmail?: string;
  guestData?: { nombre?: string; apellido?: string; telefono?: string };
}

export type ReservarTurnoResult =
  | { kind: 'guest_pending'; email: string }
  | { kind: 'created'; turno: Prisma.TurnoGetPayload<object> };

export type ConfirmarReservaGuestResult =
  | { kind: 'account_exists'; email: string }
  | { kind: 'confirmed'; turno: Prisma.TurnoGetPayload<object> };

/**
 * Reserve an appointment slot.
 *
 * Validates the requested slot against the professional's availability,
 * block-out windows and FREE-plan quota, then either:
 * - (guest, no account) creates a 24h email-verification record and returns
 *   `guest_pending`, or
 * - (authenticated paciente) books the turno inside an advisory-locked
 *   transaction, notifies both parties and returns `created`.
 *
 * Google Calendar sync is intentionally left to the caller so it can run
 * after the HTTP response (fire-and-forget).
 */
export async function reservarTurno(input: ReservarTurnoInput): Promise<ReservarTurnoResult> {
  const { userId, profesionalId, modalidad } = input;
  const fechaHoraDate = new Date(input.fechaHora);

  if (Number.isNaN(fechaHoraDate.getTime()) || fechaHoraDate <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La fecha del turno debe ser futura y valida');
  }

  const clinicParts = getClinicDateTimeParts(fechaHoraDate);

  if (clinicParts.minute % SLOT_GRID_STEP_MIN !== 0) {
    throw new AppError(400, 'VALIDATION_ERROR', `El horario debe alinearse a bloques de ${SLOT_GRID_STEP_MIN} minutos`);
  }

  const profesional = await prisma.profesional.findUnique({ where: { id: profesionalId } });
  if (!profesional || !profesional.activo) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const duracionMin = await resolveDuracionMin(profesionalId, input.tipoConsultaId);

  let paciente: Prisma.PacienteGetPayload<object> | null = null;
  if (userId) {
    paciente = await prisma.paciente.findUnique({ where: { usuarioId: userId } });
    if (!paciente) {
      throw new AppError(404, 'PACIENTE_NOT_FOUND', 'Paciente no encontrado');
    }
  }

  const diaSemanaBooking = clinicParts.weekday;
  const bookingStartMinutes = clinicParts.hour * 60 + clinicParts.minute;
  const dispSlots = await prisma.disponibilidad.findMany({
    where: { profesionalId, diaSemana: diaSemanaBooking, activo: true },
  });
  const matchingDisp = findMatchingAvailability(dispSlots, modalidad, bookingStartMinutes, duracionMin);

  if (!matchingDisp) {
    throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado no esta disponible para este profesional');
  }

  const slotDate = getClinicDateOnlyUtc(clinicParts.dateKey);
  const bloqueos = await prisma.bloqueoDisponibilidad.findMany({
    where: {
      profesionalId,
      fechaInicio: { lte: slotDate },
      fechaFin: { gte: slotDate },
    },
  });
  if (bloqueos.length > 0) {
    const slotMinutes = clinicParts.hour * 60 + clinicParts.minute;
    const bloqueado = hasBlockConflict(bloqueos, slotMinutes, duracionMin);
    if (bloqueado) throw new AppError(409, 'HORARIO_BLOQUEADO', 'El profesional no está disponible en ese horario');
  }

  // FREE plan turno limit check
  const prof = await prisma.profesional.findUnique({
    where: { id: profesionalId },
    select: { plan: true },
  });
  if (prof?.plan === 'FREE') {
    const { start, end } = getClinicMonthBounds(clinicParts.year, clinicParts.month);
    // Count only turnos that consume the monthly quota: active or completed.
    // Excludes CANCELADO and AUSENTE (no-shows) so cancellations / no-shows don't
    // wrongly exhaust a FREE plan's limit.
    const count = await prisma.turno.count({
      where: {
        profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { in: ['RESERVADO', 'CONFIRMADO', 'COMPLETADO'] },
      },
    });
    if (count >= FREE_PLAN_MONTHLY_TURNO_LIMIT) {
      throw new AppError(
        403,
        'PLAN_LIMIT_REACHED',
        'El profesional alcanzó el límite de 20 turnos mensuales del plan Free'
      );
    }
  }

  if (!userId) {
    return reservarGuest(input, fechaHoraDate, profesionalId, duracionMin);
  }

  // Native WebRTC migration: no external (Jitsi) link is persisted. Virtual turnos
  // are joined from inside the app via the auth-gated /turnos/:id/video-token flow.
  const linkVideollamada = null;
  const lugarAtencionTurno = matchingDisp?.lugarAtencion ?? profesional.lugarAtencion ?? null;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      await acquireAppointmentDayLock(tx, profesionalId, clinicParts.dateKey);

      const { start, end } = getClinicDayBoundsForInstant(fechaHoraDate);
      const turnosDelDia = await tx.turno.findMany({
        where: {
          profesionalId,
          fechaHora: { gte: start, lt: end },
          estado: { notIn: ['CANCELADO'] },
        },
        select: { fechaHora: true, duracionMin: true, estado: true },
      });

      if (hasAppointmentConflict(turnosDelDia, fechaHoraDate, duracionMin)) {
        throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
      }

      return tx.turno.create({
        data: {
          profesionalId,
          pacienteId: paciente!.id,
          tipoConsultaId: input.tipoConsultaId ?? null,
          duracionMin,
          fechaHora: fechaHoraDate,
          modalidad,
          linkVideollamada,
          lugarAtencion: lugarAtencionTurno,
          estado: 'RESERVADO',
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
    }
    if (err instanceof Prisma.PrismaClientValidationError) {
      console.error('[turnos] Prisma validation error:', err.message);
      throw new AppError(400, 'VALIDATION_ERROR', `Error al crear el turno: ${err.message}`);
    }
    throw err;
  }

  await notifyBookingParties(result.id);

  return { kind: 'created', turno: result };
}

/**
 * Guest (account-less) booking path: persists a verification token and emails
 * the visitor a confirmation link. The turno itself is created later by
 * {@link confirmarReservaGuest} once the link is followed.
 */
async function reservarGuest(
  input: ReservarTurnoInput,
  fechaHoraDate: Date,
  profesionalId: string,
  duracionMin: number
): Promise<ReservarTurnoResult> {
  if (process.env.ENABLE_GUEST_BOOKING !== 'true') {
    throw new AppError(403, 'GUEST_BOOKING_DISABLED', 'La reserva de turnos para invitados está deshabilitada temporalmente.');
  }

  const email = input.guestEmail;
  const pacienteData = input.guestData;
  if (!email) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El email es requerido para reserva de invitado');
  }
  if (!pacienteData || !pacienteData.nombre || !pacienteData.apellido) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El nombre y apellido son requeridos para reserva de invitado');
  }

  // Check slot conflict again before reserving
  const { start, end } = getClinicDayBoundsForInstant(fechaHoraDate);
  const turnosDelDia = await prisma.turno.findMany({
    where: {
      profesionalId,
      fechaHora: { gte: start, lt: end },
      estado: { notIn: ['CANCELADO'] },
    },
    select: { fechaHora: true, duracionMin: true, estado: true },
  });

  if (hasAppointmentConflict(turnosDelDia, fechaHoraDate, duracionMin)) {
    throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
  }

  const token = randomBytes(32).toString('hex');
  await prisma.bookingVerification.create({
    data: {
      token,
      email,
      nombre: pacienteData.nombre,
      apellido: pacienteData.apellido,
      profesionalId,
      tipoConsultaId: input.tipoConsultaId ?? null,
      duracionMin,
      fechaHora: fechaHoraDate,
      modalidad: input.modalidad,
      telefonoPaciente: pacienteData.telefono,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hour expiry
    },
  });

  const confirmUrl = `${process.env.FRONTEND_URL}/auth/confirmar-turno?token=${token}`;
  sendNotification(['EMAIL'], {
    event: 'BOOKING_CONFIRMATION',
    title: 'Confirmá tu reserva de turno',
    message: 'Haz clic en el enlace para confirmar tu reserva. Este enlace vence en 24 horas.',
    userEmail: email,
    meta: { confirmUrl, nombre: pacienteData.nombre },
  }).catch((err) => console.error('[turnos] confirmation email error:', err));

  return { kind: 'guest_pending', email };
}

/**
 * Notify both paciente and profesional that a turno was just reserved, and
 * resolve any waitlist subscription the paciente held for the slot.
 */
async function notifyBookingParties(turnoId: string): Promise<void> {
  const turnoConRelaciones = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { profesional: true, paciente: true },
  });

  if (!turnoConRelaciones) return;

  if (turnoConRelaciones.pacienteId) {
    await resolveWaitlistForBooking({
      profesionalId: turnoConRelaciones.profesionalId,
      pacienteId: turnoConRelaciones.pacienteId,
      fechaHora: turnoConRelaciones.fechaHora,
      modalidad: turnoConRelaciones.modalidad as 'PRESENCIAL' | 'VIRTUAL',
    });
  }

  // Notificar al paciente
  if (turnoConRelaciones.paciente) {
    await notifyTurnoUser(
      {
        notifEmail: turnoConRelaciones.paciente.notifEmail,
        notifWhatsapp: turnoConRelaciones.paciente.notifWhatsapp,
      },
      {
        event: 'TURNO_RESERVADO',
        title: 'Turno reservado correctamente',
        message: `Tu turno con ${turnoConRelaciones.profesional.nombre} ${turnoConRelaciones.profesional.apellido} fue reservado correctamente.`,
        userEmail: turnoConRelaciones.paciente.email,
        userPhone: turnoConRelaciones.paciente.telefono ?? undefined,
        meta: {
          turnoId: turnoConRelaciones.id,
          fechaHora: turnoConRelaciones.fechaHora.toISOString(),
          profesional: `Dr/a. ${turnoConRelaciones.profesional.nombre} ${turnoConRelaciones.profesional.apellido}`,
          modalidad: turnoConRelaciones.modalidad,
          lugarAtencion: turnoConRelaciones.lugarAtencion ?? turnoConRelaciones.profesional.lugarAtencion ?? undefined,
          linkVideollamada: turnoConRelaciones.linkVideollamada ?? undefined,
        },
      },
      {
        usuarioId: turnoConRelaciones.paciente.usuarioId,
        tipo: 'TURNO_RESERVADO',
        titulo: 'Turno reservado',
        cuerpo: `Tu turno con Dr/a. ${turnoConRelaciones.profesional.nombre} ${turnoConRelaciones.profesional.apellido} fue reservado para el ${formatClinicDateTimeEs(turnoConRelaciones.fechaHora)}.`,
        link: '/dashboard/paciente',
      }
    );
  }

  // Notificar al profesional
  const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoConRelaciones.profesional.usuarioId } });
  const pacNombre = turnoConRelaciones.paciente
    ? `${turnoConRelaciones.paciente.nombre} ${turnoConRelaciones.paciente.apellido}`
    : 'Paciente sin cuenta';
  await notifyTurnoUser(
    {
      notifEmail: turnoConRelaciones.profesional.notifEmail,
      notifWhatsapp: turnoConRelaciones.profesional.notifWhatsapp,
    },
    {
      event: 'TURNO_RESERVADO',
      title: 'Nuevo turno reservado',
      message: `${pacNombre} reservó un turno para el ${formatClinicDateTimeEs(turnoConRelaciones.fechaHora)}.`,
      userEmail: profUsuario?.email,
      userPhone: turnoConRelaciones.profesional.telefono || undefined,
      meta: {
        turnoId: turnoConRelaciones.id,
        fechaHora: turnoConRelaciones.fechaHora.toISOString(),
        paciente: pacNombre,
        modalidad: turnoConRelaciones.modalidad,
      },
    },
    {
      usuarioId: turnoConRelaciones.profesional.usuarioId,
      tipo: 'TURNO_RESERVADO',
      titulo: 'Nuevo turno',
      cuerpo: `${pacNombre} reservó un turno para el ${formatClinicDateTimeEs(turnoConRelaciones.fechaHora)}.`,
      link: '/dashboard',
    }
  );
}

/**
 * Confirm a guest booking via its emailed verification token.
 *
 * Account model: we never fabricate a `usuarioId`. If the email already belongs
 * to a real `Usuario`, we refuse to auto-bind the booking (would let a stranger
 * attach turnos to someone else's account — C-A5) and ask the visitor to log in.
 * Otherwise we create a real `Usuario` + `Paciente` (C-A4) atomically with the
 * turno, and email a one-time link so the guest can set a password and claim it.
 */
export async function confirmarReservaGuest(token: string): Promise<ConfirmarReservaGuestResult> {
  if (process.env.ENABLE_GUEST_BOOKING !== 'true') {
    throw new AppError(403, 'GUEST_BOOKING_DISABLED', 'La reserva de turnos para invitados está deshabilitada temporalmente.');
  }

  const verification = await prisma.bookingVerification.findUnique({ where: { token } });

  if (!verification) {
    throw new AppError(400, 'INVALID_TOKEN', 'Token de confirmación inválido o expirado');
  }

  if (new Date() > verification.expiresAt) {
    await prisma.bookingVerification.delete({ where: { token } });
    throw new AppError(400, 'EXPIRED_TOKEN', 'El enlace de confirmación ha expirado');
  }

  // If the email already has an account, do NOT auto-bind. Keep the verification
  // record so the visitor can retry after logging in.
  const existingUsuario = await prisma.usuario.findUnique({ where: { email: verification.email } });
  if (existingUsuario) {
    return { kind: 'account_exists', email: verification.email };
  }

  // Native WebRTC migration: no external (Jitsi) link is persisted for guests either.
  const linkVideollamada = null;
  const randomPassword = randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  let turno: Prisma.TurnoGetPayload<object>;
  try {
    turno = await prisma.$transaction(async (tx) => {
      const verificationClinicParts = getClinicDateTimeParts(verification.fechaHora);
      await acquireAppointmentDayLock(tx, verification.profesionalId, verificationClinicParts.dateKey);

      const { start, end } = getClinicDayBoundsForInstant(verification.fechaHora);
      const turnosDelDia = await tx.turno.findMany({
        where: {
          profesionalId: verification.profesionalId,
          fechaHora: { gte: start, lt: end },
          estado: { notIn: ['CANCELADO'] },
        },
        select: { fechaHora: true, duracionMin: true, estado: true },
      });

      if (hasAppointmentConflict(turnosDelDia, verification.fechaHora, verification.duracionMin)) {
        throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario ya fue reservado');
      }

      // Real account, created atomically with the turno so a slot conflict rolls
      // back the account too.
      const nuevoUsuario = await tx.usuario.create({
        data: {
          email: verification.email,
          passwordHash,
          rol: 'PACIENTE',
          paciente: {
            create: {
              nombre: verification.nombre,
              apellido: verification.apellido,
              email: verification.email,
              telefono: verification.telefonoPaciente,
              genero: 'NO_ESPECIFICADO',
            },
          },
        },
        include: { paciente: true },
      });

      return tx.turno.create({
        data: {
          profesionalId: verification.profesionalId,
          pacienteId: nuevoUsuario.paciente!.id,
          tipoConsultaId: verification.tipoConsultaId,
          duracionMin: verification.duracionMin,
          fechaHora: verification.fechaHora,
          modalidad: verification.modalidad as 'PRESENCIAL' | 'VIRTUAL',
          linkVideollamada,
          estado: 'RESERVADO',
        },
      });
    });
  } catch (err) {
    // Unique-email race: someone registered between the check and the create.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { kind: 'account_exists', email: verification.email };
    }
    throw err;
  }

  await prisma.bookingVerification.delete({ where: { token } });

  // One-time link so the guest can set a password and claim the new account.
  const resetToken = randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: {
      email: verification.email,
      token: resetToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const setPasswordUrl = `${baseUrl}/forgot-password?token=${resetToken}`;

  sendNotification(['EMAIL'], {
    event: 'BOOKING_CONFIRMED',
    title: 'Turno confirmado',
    message: 'Tu turno ha sido confirmado. Creamos una cuenta para vos: definí tu contraseña para gestionar tus turnos.',
    userEmail: verification.email,
    meta: { turnoId: turno.id, setPasswordUrl },
  }).catch(() => {});

  return { kind: 'confirmed', turno };
}
