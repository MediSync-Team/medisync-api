import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { randomBytes } from 'crypto';
import { EstadoTurno, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { asyncHandler, success, error, AppError } from '../utils/response';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { sendNotification, resolveChannels } from '../utils/notifications';
import { notifyWaitlistForReleasedSlot, resolveWaitlistForBooking } from '../services/waitlist.service';
import { analyzePreconsulta } from '../services/preconsulta.service';
import { createNotification } from '../services/notification.service';
import { issueVideoTicket } from '../services/video-room.service';
import { getAvailableSlotsForProfessional } from '../services/slot-availability.service';
import {
  syncTurnoCreated, syncTurnoRescheduled, syncTurnoCancelled,
  syncTurnoCreatedForPaciente, syncTurnoRescheduledForPaciente, syncTurnoCancelledForPaciente,
} from '../services/calendar-sync.service';
import { getProfesionalIdByUsuario } from '../utils/auth-helpers';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { validateRequest } from '../utils/validation';
import { DEFAULT_APPOINTMENT_DURATION_MIN, findMatchingAvailability, hasAppointmentConflict, hasBlockConflict } from '../utils/appointment-conflicts';
import { canTransitionTurnoState } from '../utils/turno-state';
import {
  formatClinicDateTimeEs,
  getClinicDateOnlyUtc,
  getClinicDateTimeParts,
  getClinicDayBoundsFromDateString,
  getClinicDayBoundsForInstant,
  getClinicMonthBounds,
} from '../utils/clinic-time';
import rateLimit from 'express-rate-limit';

const router = Router();

// Booking limiter kept for future guest booking; authenticated patients skip it.
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Demasiadas solicitudes de reserva. Intenta más tarde.' } },
  skip: (req: any) => {
    // Don't rate limit authenticated pacientes.
    return req.user?.rol === 'PACIENTE';
  },
});

async function assertTurnoAccess(turnoId: string, req: AuthRequest) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente: { select: { usuarioId: true } },
      profesional: { select: { usuarioId: true } },
      pago: true,
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const userId = req.user!.userId;
  const isPacienteOwner = turno.paciente?.usuarioId === userId;
  const isProfesionalOwner = turno.profesional.usuarioId === userId;

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para acceder al turno');
  }

  return { turno, isPacienteOwner, isProfesionalOwner };
}

function getTurnoStatusResponse(turnoId: string) {
  return prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente: true,
      profesional: { include: { especialidad: true } },
    },
  });
}

function canCancelTurno(turnoFechaHora: Date): boolean {
  const cancellationWindowHours = Number(process.env.CANCELLATION_WINDOW_HOURS || 24);
  const diffMs = turnoFechaHora.getTime() - Date.now();
  return diffMs >= cancellationWindowHours * 60 * 60 * 1000;
}

function createVideoCallLink(): string {
  return `https://meet.jit.si/MediSync-${Math.random().toString(36).substring(2, 10)}`;
}

function assertPreconsultaEditable(turno: { fechaHora: Date; estado: string }) {
  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede completar preconsulta en turnos reservados o confirmados');
  }

  if (turno.fechaHora.getTime() <= Date.now()) {
    throw new AppError(422, 'APPOINTMENT_ALREADY_STARTED', 'La preconsulta solo se puede completar antes del turno');
  }
}

router.get('/mi-historial', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');

  const { page, limit, skip } = parsePagination(req);

  const where = { pacienteId: paciente.id, estado: 'COMPLETADO' as const };
  const [turnos, total] = await Promise.all([
    prisma.turno.findMany({
      where,
      include: {
        profesional: { include: { especialidad: true } },
        evolucion: true,
        recetaIndicacion: true,
        archivos: true,
        resena: true,
      },
      orderBy: { fechaHora: 'desc' },
      skip,
      take: limit,
    }),
    prisma.turno.count({ where }),
  ]);

  res.json(success({ turnos, pagination: buildPaginationMeta(page, limit, total) }));
}));

router.get('/mis-turnos', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { tipo } = req.query;

  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user!.userId } });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const now = new Date();
  const whereClause: any = { pacienteId: paciente.id };

  if (tipo === 'proximos') {
    whereClause.fechaHora = { gte: now };
    whereClause.estado = { in: ['RESERVADO', 'CONFIRMADO'] };
  } else if (tipo === 'pasados') {
    whereClause.OR = [
      { fechaHora: { lt: now } },
      { estado: 'CANCELADO' },
    ];
    whereClause.estado = { notIn: ['RESERVADO', 'CONFIRMADO'] };
  }

  const { page, limit, skip } = parsePagination(req);

  const [turnos, total] = await Promise.all([
    prisma.turno.findMany({
      where: whereClause,
      include: { profesional: { include: { especialidad: true } } },
      orderBy: { fechaHora: tipo === 'pasados' ? 'desc' : 'asc' },
      skip,
      take: limit,
    }),
    prisma.turno.count({ where: whereClause }),
  ]);

  res.json(success({ turnos, pagination: buildPaginationMeta(page, limit, total) }));
}));

router.get('/profesional/:profesionalId', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
  if (!profesionalId || profesionalId !== req.params.profesionalId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para ver estos turnos');
  }

  const { desde, hasta, estado } = req.query;

  const where: any = { profesionalId: req.params.profesionalId };
  if (estado) where.estado = estado;
  if (desde || hasta) {
    where.fechaHora = {};
    if (desde) where.fechaHora.gte = new Date(String(desde));
    if (hasta) where.fechaHora.lte = new Date(String(hasta));
  }

  const { page, limit, skip } = parsePagination(req);

  const [turnos, total] = await Promise.all([
    prisma.turno.findMany({
      where,
      include: { paciente: true },
      orderBy: { fechaHora: 'asc' },
      skip,
      take: limit,
    }),
    prisma.turno.count({ where }),
  ]);

  res.json(success({ turnos, pagination: buildPaginationMeta(page, limit, total) }));
}));

router.get('/profesional/:profesionalId/slots-disponibles', asyncHandler(async (req, res) => {
  const { fecha, modalidad } = req.query;
  const fechaStr = String(fecha);
  if (!fecha || typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fecha es requerida y debe tener formato YYYY-MM-DD');
  }
  const slots = await getAvailableSlotsForProfessional({
    profesionalId: req.params.profesionalId,
    fecha: fechaStr,
    modalidad: modalidad ? String(modalidad) : undefined,
  });

  res.json(success(slots));
}));

router.get('/politica-cancelacion', asyncHandler(async (_req, res) => {
  const horasMinimas = Number(process.env.CANCELLATION_WINDOW_HOURS || 24);
  res.json(success({ horasMinimas }));
}));

router.get('/:id', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req);

  const turno = await prisma.turno.findUnique({
    where: { id: req.params.id },
    include: { 
      profesional: { include: { especialidad: true } },
      paciente: true,
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  res.json(success(turno));
}));

router.post(
  '/reservar',
  optionalAuthMiddleware(),
  bookingLimiter,
  [
    body('profesionalId').isUUID(),
    body('fechaHora').isISO8601(),
    body('modalidad').isIn(['PRESENCIAL', 'VIRTUAL']),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    if (req.user && req.user.rol !== 'PACIENTE') {
      res.status(403).json(error('FORBIDDEN', 'Sin permisos'));
      return;
    }
    if (!req.user && process.env.ENABLE_GUEST_BOOKING !== 'true') {
      res.status(401).json(error('UNAUTHORIZED', 'Token requerido'));
      return;
    }
    validateRequest(validationResult(req));

    const { profesionalId, fechaHora, modalidad } = req.body;
    const fechaHoraDate = new Date(fechaHora);

    if (Number.isNaN(fechaHoraDate.getTime()) || fechaHoraDate <= new Date()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La fecha del turno debe ser futura y valida');
    }

    const clinicParts = getClinicDateTimeParts(fechaHoraDate);

    if (clinicParts.minute !== 0 && clinicParts.minute !== 30) {
      throw new AppError(400, 'VALIDATION_ERROR', 'El horario debe ser en bloques de 30 minutos');
    }

    const profesional = await prisma.profesional.findUnique({ where: { id: profesionalId } });
    if (!profesional || !profesional.activo) {
      throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
    }

    let paciente: any = null;
    if (req.user) {
      paciente = await prisma.paciente.findUnique({
        where: { usuarioId: req.user.userId },
      });
      if (!paciente) {
        throw new AppError(404, 'PACIENTE_NOT_FOUND', 'Paciente no encontrado');
      }
    }

    const diaSemanaBooking = clinicParts.weekday;
    const bookingStartMinutes = clinicParts.hour * 60 + clinicParts.minute;
    const dispSlots = await prisma.disponibilidad.findMany({
      where: { profesionalId, diaSemana: diaSemanaBooking, activo: true },
    });
    const matchingDisp = findMatchingAvailability(dispSlots, modalidad, bookingStartMinutes, DEFAULT_APPOINTMENT_DURATION_MIN);

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
      const bloqueado = hasBlockConflict(bloqueos, slotMinutes, DEFAULT_APPOINTMENT_DURATION_MIN);
      if (bloqueado) throw new AppError(409, 'HORARIO_BLOQUEADO', 'El profesional no está disponible en ese horario');
    }

    // FREE plan turno limit check
    const prof = await prisma.profesional.findUnique({
      where: { id: profesionalId },
      select: { plan: true },
    });
    if (prof?.plan === 'FREE') {
      const { start, end } = getClinicMonthBounds(clinicParts.year, clinicParts.month);
      const count = await prisma.turno.count({
        where: {
          profesionalId,
          fechaHora: { gte: start, lt: end },
          estado: { notIn: ['CANCELADO'] },
        },
      });
      if (count >= 20) {
        throw new AppError(
          403,
          'PLAN_LIMIT_REACHED',
          'El profesional alcanzó el límite de 20 turnos mensuales del plan Free'
        );
      }
    }

    if (!req.user) {
      if (process.env.ENABLE_GUEST_BOOKING !== 'true') {
        throw new AppError(403, 'GUEST_BOOKING_DISABLED', 'La reserva de turnos para invitados está deshabilitada temporalmente.');
      }

      const { email, pacienteData } = req.body;
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

      if (hasAppointmentConflict(turnosDelDia, fechaHoraDate, DEFAULT_APPOINTMENT_DURATION_MIN)) {
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
          fechaHora: fechaHoraDate,
          modalidad,
          telefonoPaciente: pacienteData.telefono,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hour expiry
        },
      });

      // Send confirmation email
      const confirmUrl = `${process.env.FRONTEND_URL}/auth/confirmar-turno?token=${token}`;
      sendNotification(['EMAIL'], {
        event: 'BOOKING_CONFIRMATION',
        title: 'Confirmá tu reserva de turno',
        message: 'Haz clic en el enlace para confirmar tu reserva. Este enlace vence en 24 horas.',
        userEmail: email,
        meta: { confirmUrl, nombre: pacienteData.nombre },
      }).catch((err) => console.error('[turnos] confirmation email error:', err));

      res.status(202).json(success({
        message: 'Verifica tu email para confirmar la reserva',
        email,
      }));
      return;
    }

    const linkVideollamada = modalidad === 'VIRTUAL' ? createVideoCallLink() : null;

    const lugarAtencionTurno = matchingDisp?.lugarAtencion ?? profesional.lugarAtencion ?? null;

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const { start, end } = getClinicDayBoundsForInstant(fechaHoraDate);
        const turnosDelDia = await tx.turno.findMany({
          where: {
            profesionalId,
            fechaHora: { gte: start, lt: end },
            estado: { notIn: ['CANCELADO'] },
          },
          select: { fechaHora: true, duracionMin: true, estado: true },
        });

        if (hasAppointmentConflict(turnosDelDia, fechaHoraDate, DEFAULT_APPOINTMENT_DURATION_MIN)) {
          throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
        }

        const turno = await tx.turno.create({
          data: {
            profesionalId,
            pacienteId: paciente!.id,
            fechaHora: fechaHoraDate,
            modalidad,
            linkVideollamada,
            lugarAtencion: lugarAtencionTurno,
            estado: 'RESERVADO',
          },
        });

        return turno;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
      }
      throw err;
    }

    const turnoConRelaciones = await prisma.turno.findUnique({
      where: { id: result.id },
      include: {
        profesional: true,
        paciente: true,
      },
    });

    if (turnoConRelaciones) {
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
          const pacChannels = resolveChannels({
            notifEmail: turnoConRelaciones.paciente.notifEmail,
            notifWhatsapp: turnoConRelaciones.paciente.notifWhatsapp,
          });
          await sendNotification(pacChannels, {
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
          });
          await createNotification({
            usuarioId: turnoConRelaciones.paciente.usuarioId,
            tipo: 'TURNO_RESERVADO',
            titulo: 'Turno reservado',
            cuerpo: `Tu turno con Dr/a. ${turnoConRelaciones.profesional.nombre} ${turnoConRelaciones.profesional.apellido} fue reservado para el ${formatClinicDateTimeEs(turnoConRelaciones.fechaHora)}.`,
            link: '/dashboard/paciente',
          });
        }

        // Notificar al profesional
        {
          const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoConRelaciones.profesional.usuarioId } });
          const profChannels = resolveChannels({
            notifEmail: turnoConRelaciones.profesional.notifEmail,
            notifWhatsapp: turnoConRelaciones.profesional.notifWhatsapp,
          });
          const pacNombre = turnoConRelaciones.paciente
            ? `${turnoConRelaciones.paciente.nombre} ${turnoConRelaciones.paciente.apellido}`
            : 'Paciente sin cuenta';
          await sendNotification(profChannels, {
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
          });
          await createNotification({
            usuarioId: turnoConRelaciones.profesional.usuarioId,
            tipo: 'TURNO_RESERVADO',
            titulo: 'Nuevo turno',
            cuerpo: `${pacNombre} reservó un turno para el ${formatClinicDateTimeEs(turnoConRelaciones.fechaHora)}.`,
            link: '/dashboard',
          });
        }
      }

      res.status(201).json(success({ turno: result, linkPago: null }));
      // Fire-and-forget Google Calendar sync (profesional + paciente)
      syncTurnoCreated(result.id).catch(() => {});
      syncTurnoCreatedForPaciente(result.id).catch(() => {});
  })
);

router.post('/:id/reprogramar', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { fechaHora, modalidad } = req.body;

  if (!fechaHora) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fechaHora es requerida');
  }

  const nuevaFechaHora = new Date(String(fechaHora));
  if (Number.isNaN(nuevaFechaHora.getTime()) || nuevaFechaHora <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La nueva fecha debe ser futura y valida');
  }

  const nuevaClinicParts = getClinicDateTimeParts(nuevaFechaHora);

  if (nuevaClinicParts.minute !== 0 && nuevaClinicParts.minute !== 30) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El horario debe ser en bloques de 30 minutos');
  }

  const nuevaModalidad = modalidad || undefined;
  if (nuevaModalidad && !['PRESENCIAL', 'VIRTUAL'].includes(nuevaModalidad)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Modalidad invalida');
  }

  const { turno, isPacienteOwner, isProfesionalOwner } = await assertTurnoAccess(req.params.id, req);

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para reprogramar este turno');
  }

  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se pueden reprogramar turnos reservados o confirmados');
  }

  // Pacientes deben respetar la ventana de cancelación; profesionales pueden reprogramar sin restricción de tiempo
  if (isPacienteOwner && !canCancelTurno(turno.fechaHora)) {
    throw new AppError(
      422,
      'RESCHEDULE_WINDOW_EXCEEDED',
      `Solo podes reprogramar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  const modalidadFinal = nuevaModalidad || turno.modalidad;
  const diaSemana = nuevaClinicParts.weekday;
  const reprogramStartMinutes = nuevaClinicParts.hour * 60 + nuevaClinicParts.minute;
  const reprogramDurationMin = turno.duracionMin ?? DEFAULT_APPOINTMENT_DURATION_MIN;

  const disponibilidades = await prisma.disponibilidad.findMany({
    where: {
      profesionalId: turno.profesionalId,
      diaSemana,
      activo: true,
    },
  });

  let matchingDispRep = findMatchingAvailability(disponibilidades, modalidadFinal, reprogramStartMinutes, reprogramDurationMin);

  const slotValido = !!matchingDispRep;

  if (!slotValido) {
    throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado no esta disponible para este profesional');
  }

  const profReprog = await prisma.profesional.findUnique({ where: { id: turno.profesionalId }, select: { lugarAtencion: true } });
  const nuevaLinkVideollamada = modalidadFinal === 'VIRTUAL'
    ? turno.linkVideollamada ?? createVideoCallLink()
    : null;
  const nuevaLugarAtencion = modalidadFinal === 'PRESENCIAL'
    ? matchingDispRep?.lugarAtencion ?? profReprog?.lugarAtencion ?? null
    : null;

  const nuevaSlotDate = getClinicDateOnlyUtc(nuevaClinicParts.dateKey);
  const bloqueosReprogramacion = await prisma.bloqueoDisponibilidad.findMany({
    where: {
      profesionalId: turno.profesionalId,
      fechaInicio: { lte: nuevaSlotDate },
      fechaFin: { gte: nuevaSlotDate },
    },
  });
  const nuevaSlotMinutes = nuevaClinicParts.hour * 60 + nuevaClinicParts.minute;
  if (hasBlockConflict(bloqueosReprogramacion, nuevaSlotMinutes, reprogramDurationMin)) {
    throw new AppError(409, 'HORARIO_BLOQUEADO', 'El profesional no está disponible en ese horario');
  }

  const turnoActualizado = await prisma.$transaction(async (tx) => {
    const { start, end } = getClinicDayBoundsForInstant(nuevaFechaHora);
    const turnosDelDia = await tx.turno.findMany({
      where: {
        id: { not: turno.id },
        profesionalId: turno.profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
      select: { fechaHora: true, duracionMin: true, estado: true },
    });

    if (hasAppointmentConflict(turnosDelDia, nuevaFechaHora, reprogramDurationMin)) {
      throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El nuevo horario ya fue reservado');
    }

    return tx.turno.update({
      where: { id: turno.id },
      data: {
        fechaHora: nuevaFechaHora,
        modalidad: modalidadFinal,
        linkVideollamada: nuevaLinkVideollamada,
        lugarAtencion: nuevaLugarAtencion,
        estado: turno.pago?.estado === 'APROBADO' ? 'CONFIRMADO' : 'RESERVADO',
      },
      include: {
        paciente: { include: { usuario: { select: { id: true } } } },
        profesional: true,
        pago: true,
      },
    });
  });

  // Notificar al paciente
  if (turnoActualizado.paciente) {
    const pac = turnoActualizado.paciente;
    const who = isProfesionalOwner
      ? `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`
      : 'vos';
    const pacChannels = resolveChannels({
      notifEmail: pac.notifEmail,
      notifWhatsapp: pac.notifWhatsapp,
    });
    await sendNotification(pacChannels, {
      event: 'TURNO_REPROGRAMADO',
      title: 'Turno reprogramado',
      message: `Tu turno con ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} fue reprogramado para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
      userEmail: pac.email,
      userPhone: pac.telefono ?? undefined,
      meta: {
        turnoId: turnoActualizado.id,
        fechaHora: turnoActualizado.fechaHora.toISOString(),
        profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
        modalidad: turnoActualizado.modalidad,
        lugarAtencion: turnoActualizado.lugarAtencion ?? turnoActualizado.profesional.lugarAtencion ?? undefined,
        linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
      },
    });
    if (pac.usuario?.id) {
      await createNotification({
        usuarioId: pac.usuario.id,
        tipo: 'TURNO_REPROGRAMADO',
        titulo: 'Turno reprogramado',
        cuerpo: `${who} reprogramó tu turno con Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
        link: '/dashboard/paciente',
      });
    }
  }

  // Si lo reprogramó el paciente, notificar también al profesional
  if (isPacienteOwner) {
    const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoActualizado.profesional.usuarioId } });
    const profChannels = resolveChannels({
      notifEmail: turnoActualizado.profesional.notifEmail,
      notifWhatsapp: turnoActualizado.profesional.notifWhatsapp,
    });
    const pacNombre = turnoActualizado.paciente
      ? `${turnoActualizado.paciente.nombre} ${turnoActualizado.paciente.apellido}`
      : 'El paciente';
    await sendNotification(profChannels, {
      event: 'TURNO_REPROGRAMADO',
      title: 'Turno reprogramado por el paciente',
      message: `${pacNombre} reprogramó su turno para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
      userEmail: profUsuario?.email,
      userPhone: turnoActualizado.profesional.telefono || undefined,
      meta: {
        turnoId: turnoActualizado.id,
        fechaHora: turnoActualizado.fechaHora.toISOString(),
        paciente: pacNombre,
        modalidad: turnoActualizado.modalidad,
      },
    });
    await createNotification({
      usuarioId: turnoActualizado.profesional.usuarioId,
      tipo: 'TURNO_REPROGRAMADO',
      titulo: 'Turno reprogramado',
      cuerpo: `${pacNombre} reprogramó su turno para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
      link: '/dashboard',
    });
  }

  res.json(success(turnoActualizado));
  // Fire-and-forget Google Calendar sync (profesional + paciente)
  syncTurnoRescheduled(turnoActualizado.id).catch(() => {});
  syncTurnoRescheduledForPaciente(turnoActualizado.id).catch(() => {});
}));

router.patch('/:id', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { estado, notasCancelacion } = req.body;

  const validEstados = Object.values(EstadoTurno);
  if (estado && !validEstados.includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Estado de turno invalido');
  }

  const { turno: turnoActual, isPacienteOwner, isProfesionalOwner } = await assertTurnoAccess(req.params.id, req);

  if (isPacienteOwner && estado && estado !== 'CANCELADO') {
    throw new AppError(403, 'FORBIDDEN', 'El paciente solo puede cancelar su turno');
  }

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para modificar este turno');
  }

  if (estado === 'CANCELADO' && turnoActual.estado === 'CANCELADO') {
    const turnoCancelado = await getTurnoStatusResponse(req.params.id);
    res.json(success(turnoCancelado));
    return;
  }

  if (estado && estado !== turnoActual.estado) {
    if (!canTransitionTurnoState(turnoActual.estado, estado)) {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', `No se puede cambiar el estado de ${turnoActual.estado} a ${estado}`);
    }
  }

  if (isPacienteOwner && estado === 'CANCELADO' && !canCancelTurno(turnoActual.fechaHora)) {
    throw new AppError(
      422,
      'CANCELLATION_WINDOW_EXCEEDED',
      `Solo podes cancelar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  let cancellationSideEffectsEnabled = false;
  let turnoActualizado;

  if (estado === 'CANCELADO') {
    const result = await prisma.turno.updateMany({
      where: {
        id: req.params.id,
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      data: { estado: 'CANCELADO', notasCancelacion },
    });

    if (result.count === 0) {
      const latestTurno = await getTurnoStatusResponse(req.params.id);

      if (latestTurno?.estado === 'CANCELADO') {
        res.json(success(latestTurno));
        return;
      }

      throw new AppError(
        409,
        'INVALID_STATE_TRANSITION',
        `No se puede cambiar el estado de ${latestTurno?.estado ?? turnoActual.estado} a CANCELADO`
      );
    }

    const updatedAfterCancel = await getTurnoStatusResponse(req.params.id);
    if (!updatedAfterCancel) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }

    turnoActualizado = updatedAfterCancel;
    cancellationSideEffectsEnabled = true;
  } else {
    turnoActualizado = await prisma.turno.update({
      where: { id: req.params.id },
      data: { estado, notasCancelacion },
      include: {
        paciente: true,
        profesional: { include: { especialidad: true } },
      },
    });
  }

  const metaBase = {
    turnoId: turnoActualizado.id,
    fechaHora: turnoActualizado.fechaHora.toISOString(),
    profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
    especialidad: turnoActualizado.profesional.especialidad.nombre,
    modalidad: turnoActualizado.modalidad,
    lugarAtencion: turnoActualizado.lugarAtencion ?? turnoActualizado.profesional.lugarAtencion ?? undefined,
    linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
  };

  if (estado === 'CANCELADO' && cancellationSideEffectsEnabled) {
    // Notificar al paciente
    if (turnoActualizado.paciente) {
      const pacChannels = resolveChannels({
        notifEmail: turnoActualizado.paciente.notifEmail,
        notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
      });
      await sendNotification(pacChannels, {
        event: 'TURNO_CANCELADO',
        title: 'Turno cancelado',
        message: `Tu turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue cancelado.`,
        userEmail: turnoActualizado.paciente.email,
        userPhone: turnoActualizado.paciente.telefono ?? undefined,
        meta: metaBase,
      });
      await createNotification({
        usuarioId: turnoActualizado.paciente.usuarioId,
        tipo: 'TURNO_CANCELADO',
        titulo: 'Turno cancelado',
        cuerpo: `Tu turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue cancelado.`,
        link: '/dashboard/paciente',
      });
    }

    // Notificar al profesional si lo canceló el paciente
    if (isPacienteOwner) {
      const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoActualizado.profesional.usuarioId } });
      const profChannels = resolveChannels({
        notifEmail: turnoActualizado.profesional.notifEmail,
        notifWhatsapp: turnoActualizado.profesional.notifWhatsapp,
      });
      const pacNombre = turnoActualizado.paciente
        ? `${turnoActualizado.paciente.nombre} ${turnoActualizado.paciente.apellido}`
        : 'Paciente sin cuenta';
      await sendNotification(profChannels, {
        event: 'TURNO_CANCELADO',
        title: 'Turno cancelado por el paciente',
        message: `${pacNombre} canceló su turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)}.`,
        userEmail: profUsuario?.email,
        userPhone: turnoActualizado.profesional.telefono || undefined,
        meta: { ...metaBase, paciente: pacNombre },
      });
      await createNotification({
        usuarioId: turnoActualizado.profesional.usuarioId,
        tipo: 'TURNO_CANCELADO',
        titulo: 'Turno cancelado',
        cuerpo: `${pacNombre} canceló su turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)}.`,
        link: '/dashboard',
      });
    }

    await notifyWaitlistForReleasedSlot({
      profesionalId: turnoActualizado.profesionalId,
      fechaHora: turnoActualizado.fechaHora,
      modalidad: turnoActualizado.modalidad as 'PRESENCIAL' | 'VIRTUAL',
      turnoId: turnoActualizado.id,
    });

    if (isProfesionalOwner) {
      await prisma.auditoriaDisponibilidad.create({
        data: {
          profesionalId: turnoActualizado.profesionalId,
          tipoEvento: 'TURNO_CANCELADO_POR_PROFESIONAL',
          turnoId: turnoActualizado.id,
          detalle: { fechaHora: turnoActualizado.fechaHora.toISOString(), notasCancelacion, pacienteId: turnoActualizado.pacienteId },
        },
      }).catch(() => {});
    }
  }

  if (estado === 'CONFIRMADO' && turnoActualizado.paciente) {
    const pacChannels = resolveChannels({
      notifEmail: turnoActualizado.paciente.notifEmail,
      notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
    });
    await sendNotification(pacChannels, {
      event: 'TURNO_CONFIRMADO',
      title: 'Turno confirmado',
      message: `Tu turno con ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} fue confirmado.`,
      userEmail: turnoActualizado.paciente.email,
      userPhone: turnoActualizado.paciente.telefono ?? undefined,
      meta: metaBase,
    });
    await createNotification({
      usuarioId: turnoActualizado.paciente.usuarioId,
      tipo: 'TURNO_CONFIRMADO',
      titulo: 'Turno confirmado',
      cuerpo: `Tu turno con Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue confirmado.`,
      link: '/dashboard/paciente',
    });
  }

  res.json(success(turnoActualizado));
  // Fire-and-forget Google Calendar sync on cancellation (profesional + paciente)
  if (estado === 'CANCELADO' && cancellationSideEffectsEnabled) {
    syncTurnoCancelled(turnoActualizado.id).catch(() => {});
    syncTurnoCancelledForPaciente(turnoActualizado.id).catch(() => {});
  }
}));

router.get('/:id/evolucion', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req);

  const evolucion = await prisma.evolucion.findUnique({
    where: { turnoId: req.params.id },
    include: { turno: { include: { archivos: true } } },
  });

  res.json(success(evolucion));
}));

router.get('/:id/receta', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req);

  const receta = await prisma.recetaIndicacion.findUnique({
    where: { turnoId: req.params.id },
  });

  res.json(success(receta));
}));

router.get('/:id/preconsulta', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req);

  res.json(success({
    motivo: turno.preconsultaMotivo,
    sintomas: turno.preconsultaSintomas,
    escalaDolor: turno.preconsultaEscalaDolor,
    escalaAnsiedad: turno.preconsultaEscalaAnsiedad,
    inicioSintomas: turno.preconsultaInicioSintomas,
    temperatura: turno.preconsultaTemperatura ? Number(turno.preconsultaTemperatura) : null,
    notasPaciente: turno.preconsultaNotasPaciente,
    riesgo: turno.preconsultaRiesgo,
    flags: turno.preconsultaFlags,
    resumen: turno.preconsultaResumen,
    completadaAt: turno.preconsultaCompletadaAt,
  }));
}));

router.put('/:id/preconsulta', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const {
    motivo,
    sintomas,
    escalaDolor,
    escalaAnsiedad,
    inicioSintomas,
    temperatura,
    notasPaciente,
  } = req.body;

  const { turno, isPacienteOwner } = await assertTurnoAccess(req.params.id, req);

  if (!isPacienteOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Solo el paciente del turno puede completar la preconsulta');
  }

  assertPreconsultaEditable(turno);

  if (typeof motivo !== 'string' || motivo.trim().length < 5 || motivo.trim().length > 400) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El motivo debe tener entre 5 y 400 caracteres');
  }

  if (typeof sintomas !== 'string' || sintomas.trim().length < 5 || sintomas.trim().length > 1200) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Los sintomas deben tener entre 5 y 1200 caracteres');
  }

  if (!Number.isInteger(escalaDolor) || escalaDolor < 0 || escalaDolor > 10) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La escala de dolor debe estar entre 0 y 10');
  }

  if (!Number.isInteger(escalaAnsiedad) || escalaAnsiedad < 0 || escalaAnsiedad > 10) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La escala de ansiedad debe estar entre 0 y 10');
  }

  const inicioNormalizado = typeof inicioSintomas === 'string' && inicioSintomas.trim().length > 0
    ? inicioSintomas.trim().slice(0, 80)
    : null;

  const notasNormalizadas = typeof notasPaciente === 'string' && notasPaciente.trim().length > 0
    ? notasPaciente.trim().slice(0, 2000)
    : null;

  let temperaturaNormalizada: number | null = null;
  if (temperatura !== undefined && temperatura !== null && temperatura !== '') {
    if (typeof temperatura !== 'number' || Number.isNaN(temperatura) || temperatura < 34 || temperatura > 43) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La temperatura debe estar entre 34 y 43');
    }
    temperaturaNormalizada = Math.round(temperatura * 10) / 10;
  }

  // Load especialidad name for AI context
  const profConEspecialidad = await prisma.profesional.findUnique({
    where: { id: turno.profesionalId },
    include: { especialidad: { select: { nombre: true } } },
  });

  const analysis = await analyzePreconsulta({
    motivo: motivo.trim(),
    sintomas: sintomas.trim(),
    escalaDolor,
    escalaAnsiedad,
    inicioSintomas: inicioNormalizado,
    temperatura: temperaturaNormalizada,
    notasPaciente: notasNormalizadas,
    especialidad: profConEspecialidad?.especialidad?.nombre ?? null,
  });

  const updated = await prisma.turno.update({
    where: { id: turno.id },
    data: {
      preconsultaMotivo: motivo.trim(),
      preconsultaSintomas: sintomas.trim(),
      preconsultaEscalaDolor: escalaDolor,
      preconsultaEscalaAnsiedad: escalaAnsiedad,
      preconsultaInicioSintomas: inicioNormalizado,
      preconsultaTemperatura: temperaturaNormalizada,
      preconsultaNotasPaciente: notasNormalizadas,
      preconsultaRiesgo: analysis.riesgo,
      preconsultaFlags: analysis.flags,
      preconsultaResumen: analysis.resumen,
      preconsultaCompletadaAt: new Date(),
    },
    select: {
      id: true,
      preconsultaMotivo: true,
      preconsultaSintomas: true,
      preconsultaEscalaDolor: true,
      preconsultaEscalaAnsiedad: true,
      preconsultaInicioSintomas: true,
      preconsultaTemperatura: true,
      preconsultaNotasPaciente: true,
      preconsultaRiesgo: true,
      preconsultaFlags: true,
      preconsultaResumen: true,
      preconsultaCompletadaAt: true,
    },
  });

  res.json(success({
    motivo: updated.preconsultaMotivo,
    sintomas: updated.preconsultaSintomas,
    escalaDolor: updated.preconsultaEscalaDolor,
    escalaAnsiedad: updated.preconsultaEscalaAnsiedad,
    inicioSintomas: updated.preconsultaInicioSintomas,
    temperatura: updated.preconsultaTemperatura ? Number(updated.preconsultaTemperatura) : null,
    notasPaciente: updated.preconsultaNotasPaciente,
    riesgo: updated.preconsultaRiesgo,
    flags: updated.preconsultaFlags,
    resumen: updated.preconsultaResumen,
    completadaAt: updated.preconsultaCompletadaAt,
    aiGenerated: analysis.aiGenerated,
  }));
}));

router.post('/:id/evolucion', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { contenido } = req.body;

  const turno = await prisma.turno.findUnique({
    where: { id: req.params.id },
    include: { profesional: { select: { usuarioId: true } } },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (turno.profesional.usuarioId !== req.user!.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para actualizar esta evolucion');
  }

  if (!contenido || String(contenido).trim().length < 5) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El contenido debe tener al menos 5 caracteres');
  }

  const evolucion = await prisma.evolucion.upsert({
    where: { turnoId: req.params.id },
    update: { contenido },
    create: { turnoId: req.params.id, contenido },
  });

  res.status(201).json(success(evolucion));
}));

router.post('/:id/receta', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const {
    diagnostico,
    planTratamiento,
    medicamentos,
    indicaciones,
    estudiosSolicitados,
    proximoControl,
    advertencias,
    observaciones,
  } = req.body;

  const turno = await prisma.turno.findUnique({
    where: { id: req.params.id },
    include: {
      profesional: { select: { usuarioId: true, nombre: true, apellido: true, matricula: true, especialidad: { select: { nombre: true } } } },
      paciente: { select: { nombre: true, apellido: true, email: true } },
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (turno.profesional.usuarioId !== req.user!.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para emitir indicaciones en este turno');
  }

  if (!['CONFIRMADO', 'COMPLETADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede emitir receta/indicaciones en turnos confirmados o completados');
  }

  if (typeof diagnostico !== 'string' || diagnostico.trim().length < 5 || diagnostico.trim().length > 2000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El diagnostico debe tener entre 5 y 2000 caracteres');
  }

  if (typeof indicaciones !== 'string' || indicaciones.trim().length < 5 || indicaciones.trim().length > 4000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Las indicaciones deben tener entre 5 y 4000 caracteres');
  }

  const normalize = (value: unknown, max: number) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
  };

  const receta = await prisma.recetaIndicacion.upsert({
    where: { turnoId: req.params.id },
    update: {
      diagnostico: diagnostico.trim(),
      planTratamiento: normalize(planTratamiento, 4000),
      medicamentos: normalize(medicamentos, 4000),
      indicaciones: indicaciones.trim(),
      estudiosSolicitados: normalize(estudiosSolicitados, 4000),
      proximoControl: normalize(proximoControl, 200),
      advertencias: normalize(advertencias, 2000),
      observaciones: normalize(observaciones, 3000),
      emitidaAt: new Date(),
    },
    create: {
      turnoId: req.params.id,
      diagnostico: diagnostico.trim(),
      planTratamiento: normalize(planTratamiento, 4000),
      medicamentos: normalize(medicamentos, 4000),
      indicaciones: indicaciones.trim(),
      estudiosSolicitados: normalize(estudiosSolicitados, 4000),
      proximoControl: normalize(proximoControl, 200),
      advertencias: normalize(advertencias, 2000),
      observaciones: normalize(observaciones, 3000),
      emitidaAt: new Date(),
    },
  });

  const recetaTexto = [
    `MediSync - Receta e indicaciones`,
    `Profesional: Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
    `Especialidad: ${turno.profesional.especialidad.nombre}`,
    turno.profesional.matricula ? `Matricula: ${turno.profesional.matricula}` : null,
    `Paciente: ${turno.paciente ? `${turno.paciente.nombre} ${turno.paciente.apellido}` : 'Sin cuenta'}`,
    `Fecha atencion: ${turno.fechaHora.toLocaleDateString('es-AR')} ${turno.fechaHora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
    '',
    `Diagnostico:`,
    receta.diagnostico,
    '',
    receta.planTratamiento ? `Plan de tratamiento:\n${receta.planTratamiento}\n` : null,
    receta.medicamentos ? `Medicamentos:\n${receta.medicamentos}\n` : null,
    `Indicaciones:`,
    receta.indicaciones,
    '',
    receta.estudiosSolicitados ? `Estudios solicitados:\n${receta.estudiosSolicitados}\n` : null,
    receta.proximoControl ? `Proximo control: ${receta.proximoControl}` : null,
    receta.advertencias ? `Advertencias: ${receta.advertencias}` : null,
    receta.observaciones ? `Observaciones: ${receta.observaciones}` : null,
    '',
    `Emitida: ${receta.emitidaAt.toLocaleString('es-AR')}`,
  ].filter(Boolean).join('\n');

  // Notificar al paciente que la receta fue emitida
  if (turno.paciente?.email) {
    const pacienteCompleto = await prisma.paciente.findFirst({
      where: { email: turno.paciente.email },
      select: { usuarioId: true, notifEmail: true, notifWhatsapp: true, telefono: true },
    });
    if (pacienteCompleto) {
      const pacChannels = resolveChannels({
        notifEmail: pacienteCompleto.notifEmail,
        notifWhatsapp: pacienteCompleto.notifWhatsapp,
      });
      await sendNotification(pacChannels, {
        event: 'RECETA_EMITIDA',
        title: 'Tu receta fue emitida',
        message: `${turno.profesional.nombre} ${turno.profesional.apellido} emitió tu receta/indicaciones de la consulta del ${turno.fechaHora.toLocaleDateString('es-AR')}.`,
        userEmail: turno.paciente.email,
        userPhone: pacienteCompleto.telefono ?? undefined,
        meta: {
          turnoId: turno.id,
          fechaHora: turno.fechaHora.toISOString(),
          profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
          especialidad: turno.profesional.especialidad.nombre,
        },
      });
      await createNotification({
        usuarioId: pacienteCompleto.usuarioId,
        tipo: 'RECETA_EMITIDA',
        titulo: 'Receta emitida',
        cuerpo: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido} emitió tu receta de la consulta del ${turno.fechaHora.toLocaleDateString('es-AR')}.`,
        link: '/dashboard/paciente',
      });
    }
  }

  res.status(201).json(success({
    receta,
    shareText: recetaTexto,
  }));
}));

/**
 * GET /turnos/:id/video-token
 * Issues a short-lived WebSocket ticket for the native video room.
 */
router.get('/:id/video-token', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req);

  if (turno.modalidad !== 'VIRTUAL') {
    throw new AppError(400, 'NOT_VIRTUAL', 'Este turno no es virtual');
  }

  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede unir a turnos reservados o confirmados');
  }

  const ticket = issueVideoTicket(turno.id, req.user!.userId);
  res.json(success({ ticket, roomId: turno.id }));
}));

router.get('/:id/auditoria-cancelacion', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req);

  if (turno.estado !== 'CANCELADO') {
    res.json(success(null));
    return;
  }

  const auditoria = await prisma.auditoriaDisponibilidad.findFirst({
    where: {
      turnoId: req.params.id,
      tipoEvento: { in: ['TURNO_CANCELADO_POR_BLOQUEO', 'TURNO_CANCELADO_POR_PROFESIONAL'] },
    },
  });

  res.json(success(auditoria || null));
}));

// POST /api/turnos/confirmar-reserva?token=...
router.post('/confirmar-reserva', [
  body('token').isString().isLength({ min: 32 }),
], asyncHandler(async (req, res) => {
  validateRequest(validationResult(req));
  if (process.env.ENABLE_GUEST_BOOKING !== 'true') {
    throw new AppError(403, 'GUEST_BOOKING_DISABLED', 'La reserva de turnos para invitados está deshabilitada temporalmente.');
  }


  const { token } = req.body;

  const verification = await prisma.bookingVerification.findUnique({
    where: { token },
  });

  if (!verification) {
    throw new AppError(400, 'INVALID_TOKEN', 'Token de confirmación inválido o expirado');
  }

  if (new Date() > verification.expiresAt) {
    await prisma.bookingVerification.delete({ where: { token } });
    throw new AppError(400, 'EXPIRED_TOKEN', 'El enlace de confirmación ha expirado');
  }

  // Create or find paciente
  let paciente = await prisma.paciente.findFirst({
    where: { email: verification.email },
  });

  if (!paciente) {
    paciente = await prisma.paciente.create({
      data: {
        usuarioId: 'guest-' + verification.email,
        nombre: verification.nombre,
        apellido: verification.apellido,
        email: verification.email,
        telefono: verification.telefonoPaciente,
        genero: 'NO_ESPECIFICADO',
      },
    });
  }

  // Create the actual turno
  const linkVideollamada = verification.modalidad === 'VIRTUAL'
    ? `https://meet.jit.si/MediSync-${Math.random().toString(36).substring(2, 10)}`
    : null;

  const turno = await prisma.$transaction(async (tx) => {
    const { start, end } = getClinicDayBoundsForInstant(verification.fechaHora);
    const turnosDelDia = await tx.turno.findMany({
      where: {
        profesionalId: verification.profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
      select: { fechaHora: true, duracionMin: true, estado: true },
    });

    if (hasAppointmentConflict(turnosDelDia, verification.fechaHora, DEFAULT_APPOINTMENT_DURATION_MIN)) {
      throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario ya fue reservado');
    }

    return tx.turno.create({
      data: {
        profesionalId: verification.profesionalId,
        pacienteId: paciente.id,
        fechaHora: verification.fechaHora,
        modalidad: verification.modalidad as any,
        linkVideollamada,
        estado: 'RESERVADO',
      },
    });
  });

  // Clean up verification record
  await prisma.bookingVerification.delete({ where: { token } });

  // Send confirmation email
  sendNotification(['EMAIL'], {
    event: 'BOOKING_CONFIRMED',
    title: 'Turno confirmado',
    message: `Tu turno ha sido confirmado. Recibirás más detalles pronto.`,
    userEmail: verification.email,
    meta: { turnoId: turno.id },
  }).catch(() => {});

  res.json(success({ turno, message: 'Turno confirmado exitosamente' }));
}));

export { router as turnosRouter };
