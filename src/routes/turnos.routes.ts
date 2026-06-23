import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { asyncHandler, success, error, AppError } from '../utils/response';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { issueVideoTicket } from '../services/video-room.service';
import { getIceServers } from '../services/turn.service';
import { getAvailableSlotsForProfessional } from '../services/slot-availability.service';
import {
  syncTurnoCreated, syncTurnoRescheduled, syncTurnoCancelled,
  syncTurnoCreatedForPaciente, syncTurnoRescheduledForPaciente, syncTurnoCancelledForPaciente,
} from '../services/calendar-sync.service';
import { getProfesionalIdByUsuario } from '../utils/auth-helpers';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { validateRequest } from '../utils/validation';
import rateLimit from 'express-rate-limit';
import { assertTurnoAccess } from '../services/turnos/turno-helpers';
import { reservarTurno, confirmarReservaGuest } from '../services/turnos/booking.service';
import { reprogramarTurno } from '../services/turnos/reschedule.service';
import { cambiarEstadoTurno } from '../services/turnos/estado.service';
import { guardarPreconsulta, guardarEvolucion, guardarReceta } from '../services/turnos/clinical.service';

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

router.get('/mi-historial', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');

  const { page, limit, skip } = parsePagination(req);

  const where = { pacienteId: paciente.id, estado: 'COMPLETADO' as const };
  const [turnos, total] = await Promise.all([
    prisma.turno.findMany({
      where,
      include: {
        // Narrow profesional to the fields HistorialCard renders — skip bio,
        // obrasSociales, notif flags, plan, timestamps, etc.
        profesional: {
          select: {
            id: true, nombre: true, apellido: true, fotoUrl: true,
            matricula: true, lugarAtencion: true, telefono: true,
            especialidad: { select: { nombre: true } },
          },
        },
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
      // Narrow profesional to the fields TurnoCard renders.
      include: {
        profesional: {
          select: {
            id: true, nombre: true, apellido: true, fotoUrl: true,
            lugarAtencion: true, precioConsulta: true,
            especialidad: { select: { nombre: true } },
          },
        },
      },
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
      // Identity + certificate fields only. The longitudinal clinical history
      // (antecedentes, alergias, etc.) is fetched on demand via
      // getHistoriaClinica, so it must not ride along on every calendar payload.
      include: {
        paciente: {
          select: {
            id: true, nombre: true, apellido: true, telefono: true,
            email: true, dni: true, fechaNacimiento: true, obraSocial: true,
          },
        },
      },
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
  await assertTurnoAccess(req.params.id, req.user!.userId);

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

    const { profesionalId, fechaHora, modalidad, email, pacienteData } = req.body;

    const result = await reservarTurno({
      userId: req.user?.userId ?? null,
      profesionalId,
      fechaHora,
      modalidad,
      guestEmail: email,
      guestData: pacienteData,
    });

    if (result.kind === 'guest_pending') {
      res.status(202).json(success({
        message: 'Verifica tu email para confirmar la reserva',
        email: result.email,
      }));
      return;
    }

    res.status(201).json(success({ turno: result.turno, linkPago: null }));
    // Fire-and-forget Google Calendar sync (profesional + paciente)
    syncTurnoCreated(result.turno.id).catch(() => {});
    syncTurnoCreatedForPaciente(result.turno.id).catch(() => {});
  })
);

router.post('/:id/reprogramar', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { fechaHora, modalidad } = req.body;

  const turnoActualizado = await reprogramarTurno({
    turnoId: req.params.id,
    userId: req.user!.userId,
    fechaHora,
    modalidad,
  });

  res.json(success(turnoActualizado));
  // Fire-and-forget Google Calendar sync (profesional + paciente)
  syncTurnoRescheduled(turnoActualizado.id).catch(() => {});
  syncTurnoRescheduledForPaciente(turnoActualizado.id).catch(() => {});
}));

router.patch('/:id', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { estado, notasCancelacion } = req.body;

  const { turno, fireCancelSync } = await cambiarEstadoTurno({
    turnoId: req.params.id,
    userId: req.user!.userId,
    estado,
    notasCancelacion,
  });

  res.json(success(turno));
  // Fire-and-forget Google Calendar sync on cancellation (profesional + paciente)
  if (fireCancelSync) {
    syncTurnoCancelled(turno.id).catch(() => {});
    syncTurnoCancelledForPaciente(turno.id).catch(() => {});
  }
}));

router.get('/:id/evolucion', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req.user!.userId);

  const evolucion = await prisma.evolucion.findUnique({
    where: { turnoId: req.params.id },
    include: { turno: { include: { archivos: true } } },
  });

  res.json(success(evolucion));
}));

router.get('/:id/receta', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req.user!.userId);

  const receta = await prisma.recetaIndicacion.findUnique({
    where: { turnoId: req.params.id },
  });

  res.json(success(receta));
}));

router.get('/:id/preconsulta', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req.user!.userId);

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
  const result = await guardarPreconsulta(req.params.id, req.user!.userId, req.body);
  res.json(success(result));
}));

router.post('/:id/evolucion', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const evolucion = await guardarEvolucion(req.params.id, req.user!.userId, req.body.contenido);
  res.status(201).json(success(evolucion));
}));

router.post('/:id/receta', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const result = await guardarReceta(req.params.id, req.user!.userId, req.body);
  res.status(201).json(success(result));
}));

/**
 * GET /turnos/:id/video-token
 * Issues a short-lived WebSocket ticket for the native video room.
 */
router.get('/:id/video-token', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req.user!.userId);

  if (turno.modalidad !== 'VIRTUAL') {
    throw new AppError(400, 'NOT_VIRTUAL', 'Este turno no es virtual');
  }

  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede unir a turnos reservados o confirmados');
  }

  // Join window: from 15 minutes before the appointment until it ends (start + duración).
  const startMs = turno.fechaHora.getTime();
  const endMs = startMs + turno.duracionMin * 60_000;
  const now = Date.now();
  const JOIN_OPENS_BEFORE_MS = 15 * 60_000;
  if (now < startMs - JOIN_OPENS_BEFORE_MS || now > endMs) {
    throw new AppError(403, 'OUTSIDE_JOIN_WINDOW', 'La videollamada está disponible desde 15 minutos antes del turno y hasta que finaliza');
  }

  const ticket = issueVideoTicket(turno.id, req.user!.userId);
  const iceServers = await getIceServers();
  res.json(success({ ticket, roomId: turno.id, iceServers }));
}));

router.get('/:id/auditoria-cancelacion', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { turno } = await assertTurnoAccess(req.params.id, req.user!.userId);

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

  const result = await confirmarReservaGuest(req.body.token);

  if (result.kind === 'account_exists') {
    res.json(success({
      turno: null,
      accountExists: true,
      message: 'Ya existe una cuenta con ese email. Iniciá sesión para reservar tu turno.',
    }));
    return;
  }

  res.json(success({ turno: result.turno, message: 'Turno confirmado exitosamente' }));
}));

export { router as turnosRouter };
