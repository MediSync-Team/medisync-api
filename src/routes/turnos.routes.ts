import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { EstadoTurno } from '@prisma/client';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { sendNotification, resolveChannels } from '../utils/notifications';
import { notifyWaitlistForReleasedSlot, resolveWaitlistForBooking } from '../services/waitlist.service';
import { analyzePreconsulta } from '../services/preconsulta.service';

const router = Router();

async function getProfesionalIdByUsuario(usuarioId: string): Promise<string | null> {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId } });
  return profesional?.id || null;
}

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

function canCancelTurno(turnoFechaHora: Date): boolean {
  const cancellationWindowHours = Number(process.env.CANCELLATION_WINDOW_HOURS || 24);
  const diffMs = turnoFechaHora.getTime() - Date.now();
  return diffMs >= cancellationWindowHours * 60 * 60 * 1000;
}

function assertPreconsultaEditable(turno: { fechaHora: Date; estado: string }) {
  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede completar preconsulta en turnos reservados o confirmados');
  }

  if (turno.fechaHora.getTime() <= Date.now()) {
    throw new AppError(422, 'APPOINTMENT_ALREADY_STARTED', 'La preconsulta solo se puede completar antes del turno');
  }
}

router.get('/mis-turnos', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const authReq = req as AuthRequest;
  const { tipo } = req.query;

  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: authReq.user!.userId } });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const now = new Date();
  const whereClause: any = { pacienteId: paciente.id };

  if (tipo === 'proximos') {
    whereClause.fechaHora = { gte: now };
    whereClause.estado = { in: ['RESERVADO', 'CONFIRMADO'] };
  } else if (tipo === 'pasados') {
    whereClause.fechaHora = { lt: now };
  }

  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const skip  = (page - 1) * limit;

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

  res.json(success({ turnos, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
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

  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const skip  = (page - 1) * limit;

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

  res.json(success({ turnos, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
}));

router.get('/profesional/:profesionalId/slots-disponibles', asyncHandler(async (req, res) => {
  const { fecha, modalidad } = req.query;
  const fechaStr = String(fecha);
  const [year, month, day] = fechaStr.split('-').map(Number);
  const fechaDate = new Date(year, month - 1, day);
  const diaSemana = fechaDate.getDay();

  const disponibilidad = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.profesionalId, diaSemana, activo: true },
  });

  const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);

  const turnosOcupados = await prisma.turno.findMany({
    where: {
      profesionalId: req.params.profesionalId,
      fechaHora: { gte: startOfDay, lte: endOfDay },
      estado: { notIn: ['CANCELADO'] },
    },
  });

  const slotsMap = new Map<string, boolean>();

  disponibilidad.forEach((disp) => {
    if (modalidad && disp.modalidad !== modalidad && disp.modalidad !== 'AMBOS') return;

    let [h, m] = disp.horaInicio.split(':').map(Number);
    const [hf, mf] = disp.horaFin.split(':').map(Number);

    while (h < hf || (h === hf && m < mf)) {
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const slotDate = new Date(year, month - 1, day, h, m, 0, 0);

      const ocupado = turnosOcupados.some((t) => t.fechaHora.getTime() === slotDate.getTime());
      if (!slotsMap.has(horaStr)) {
        slotsMap.set(horaStr, !ocupado);
      }

      m += 30;
      if (m >= 60) { h++; m -= 60; }
    }
  });

  const slots = Array.from(slotsMap.entries()).map(([hora, disponible]) => ({ hora, disponible }));

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
  [
    body('profesionalId').isUUID(),
    body('fechaHora').isISO8601(),
    body('modalidad').isIn(['PRESENCIAL', 'VIRTUAL']),
    body('paciente.email').optional().isEmail(),
    body('paciente.nombre').optional().isLength({ min: 1, max: 100 }),
    body('paciente.apellido').optional().isLength({ min: 1, max: 100 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Datos inválidos');
    }

    const { profesionalId, fechaHora, modalidad, paciente: pacienteData } = req.body;
    const fechaHoraDate = new Date(fechaHora);

    if (Number.isNaN(fechaHoraDate.getTime()) || fechaHoraDate <= new Date()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La fecha del turno debe ser futura y valida');
    }

    const profesional = await prisma.profesional.findUnique({ where: { id: profesionalId } });
    if (!profesional || !profesional.activo) {
      throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
    }

    let pacienteId: string | null = null;

    if (req.user?.rol === 'PACIENTE') {
      const paciente = await prisma.paciente.findUnique({
        where: { usuarioId: req.user.userId },
      });
      if (paciente) {
        pacienteId = paciente.id;
      }
    } else if (pacienteData) {
      const email = String(pacienteData.email || '').toLowerCase().trim();
      if (!email) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Email de paciente requerido');
      }

      const existente = await prisma.paciente.findFirst({
        where: { email },
      });
      
      if (existente) {
        pacienteId = existente.id;
      } else {
        const paciente = await prisma.paciente.create({
          data: {
            usuarioId: 'guest-' + email,
            nombre: pacienteData.nombre,
            apellido: pacienteData.apellido,
            email,
            telefono: pacienteData.telefono,
            dni: pacienteData.dni,
          },
        });
        pacienteId = paciente.id;
      }
    }

      const result = await prisma.$transaction(async (tx) => {
      const existente = await tx.turno.findFirst({
        where: { profesionalId, fechaHora: fechaHoraDate, estado: { notIn: ['CANCELADO'] } },
      });

      if (existente) {
        throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado ya fue reservado');
      }

      const linkVideollamada = modalidad === 'VIRTUAL'
        ? `https://meet.jit.si/MediSync-${Math.random().toString(36).substring(2, 10)}`
        : null;

      const turno = await tx.turno.create({
        data: {
          profesionalId,
          pacienteId,
          fechaHora: fechaHoraDate,
          modalidad,
          linkVideollamada,
          estado: 'RESERVADO',
        },
      });

      return turno;
    });

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
              lugarAtencion: turnoConRelaciones.profesional.lugarAtencion ?? undefined,
              linkVideollamada: turnoConRelaciones.linkVideollamada ?? undefined,
            },
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
            message: `${pacNombre} reservó un turno para el ${turnoConRelaciones.fechaHora.toLocaleString('es-AR')}.`,
            userEmail: profUsuario?.email,
            userPhone: turnoConRelaciones.profesional.telefono || undefined,
            meta: {
              turnoId: turnoConRelaciones.id,
              fechaHora: turnoConRelaciones.fechaHora.toISOString(),
              paciente: pacNombre,
              modalidad: turnoConRelaciones.modalidad,
            },
          });
        }
      }

      res.status(201).json(success({ turno: result, linkPago: null }));
  })
);

router.post('/:id/reprogramar', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { fechaHora, modalidad } = req.body;

  if (!fechaHora) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fechaHora es requerida');
  }

  const nuevaFechaHora = new Date(String(fechaHora));
  if (Number.isNaN(nuevaFechaHora.getTime()) || nuevaFechaHora <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La nueva fecha debe ser futura y valida');
  }

  if (nuevaFechaHora.getMinutes() !== 0 && nuevaFechaHora.getMinutes() !== 30) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El horario debe ser en bloques de 30 minutos');
  }

  const nuevaModalidad = modalidad || undefined;
  if (nuevaModalidad && !['PRESENCIAL', 'VIRTUAL'].includes(nuevaModalidad)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Modalidad invalida');
  }

  const { turno, isPacienteOwner } = await assertTurnoAccess(req.params.id, req);

  if (!isPacienteOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Solo el paciente puede reprogramar este turno');
  }

  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se pueden reprogramar turnos reservados o confirmados');
  }

  const modalidadFinal = nuevaModalidad || turno.modalidad;
  const diaSemana = nuevaFechaHora.getDay();
  const horaStr = `${String(nuevaFechaHora.getHours()).padStart(2, '0')}:${String(nuevaFechaHora.getMinutes()).padStart(2, '0')}`;

  const disponibilidades = await prisma.disponibilidad.findMany({
    where: {
      profesionalId: turno.profesionalId,
      diaSemana,
      activo: true,
    },
  });

  const slotValido = disponibilidades.some((disp) => {
    const modalidadOk = disp.modalidad === 'AMBOS' || disp.modalidad === modalidadFinal;
    const horarioOk = horaStr >= disp.horaInicio && horaStr < disp.horaFin;
    return modalidadOk && horarioOk;
  });

  if (!slotValido) {
    throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado no esta disponible para este profesional');
  }

  if (!canCancelTurno(turno.fechaHora)) {
    throw new AppError(
      422,
      'RESCHEDULE_WINDOW_EXCEEDED',
      `Solo podes reprogramar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  const turnoActualizado = await prisma.$transaction(async (tx) => {
    const conflicto = await tx.turno.findFirst({
      where: {
        id: { not: turno.id },
        profesionalId: turno.profesionalId,
        fechaHora: nuevaFechaHora,
        estado: { notIn: ['CANCELADO'] },
      },
    });

    if (conflicto) {
      throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El nuevo horario ya fue reservado');
    }

    return tx.turno.update({
      where: { id: turno.id },
      data: {
        fechaHora: nuevaFechaHora,
        modalidad: modalidadFinal,
        estado: turno.pago?.estado === 'APROBADO' ? 'CONFIRMADO' : 'RESERVADO',
      },
      include: {
        paciente: true,
        profesional: true,
        pago: true,
      },
    });
  });

  if (turnoActualizado.paciente) {
    const pacChannels = resolveChannels({
      notifEmail: turnoActualizado.paciente.notifEmail,
      notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
    });
    await sendNotification(pacChannels, {
      event: 'TURNO_REPROGRAMADO',
      title: 'Turno reprogramado',
      message: `Tu turno con ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} fue reprogramado.`,
      userEmail: turnoActualizado.paciente.email,
      userPhone: turnoActualizado.paciente.telefono ?? undefined,
      meta: {
        turnoId: turnoActualizado.id,
        fechaHora: turnoActualizado.fechaHora.toISOString(),
        profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
        modalidad: turnoActualizado.modalidad,
        lugarAtencion: turnoActualizado.profesional.lugarAtencion ?? undefined,
        linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
      },
    });
  }

  res.json(success(turnoActualizado));
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

  if (isPacienteOwner && estado === 'CANCELADO' && !canCancelTurno(turnoActual.fechaHora)) {
    throw new AppError(
      422,
      'CANCELLATION_WINDOW_EXCEEDED',
      `Solo podes cancelar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para modificar este turno');
  }

  const turnoActualizado = await prisma.turno.update({
    where: { id: req.params.id },
    data: { estado, notasCancelacion },
    include: {
      paciente: true,
      profesional: { include: { especialidad: true } },
    },
  });

  const metaBase = {
    turnoId: turnoActualizado.id,
    fechaHora: turnoActualizado.fechaHora.toISOString(),
    profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
    especialidad: turnoActualizado.profesional.especialidad.nombre,
    modalidad: turnoActualizado.modalidad,
    lugarAtencion: turnoActualizado.profesional.lugarAtencion ?? undefined,
    linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
  };

  if (estado === 'CANCELADO') {
    // Notificar al paciente
    if (turnoActualizado.paciente) {
      const pacChannels = resolveChannels({
        notifEmail: turnoActualizado.paciente.notifEmail,
        notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
      });
      await sendNotification(pacChannels, {
        event: 'TURNO_CANCELADO',
        title: 'Turno cancelado',
        message: `Tu turno del ${turnoActualizado.fechaHora.toLocaleString('es-AR')} fue cancelado.`,
        userEmail: turnoActualizado.paciente.email,
        userPhone: turnoActualizado.paciente.telefono ?? undefined,
        meta: metaBase,
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
        message: `${pacNombre} canceló su turno del ${turnoActualizado.fechaHora.toLocaleString('es-AR')}.`,
        userEmail: profUsuario?.email,
        userPhone: turnoActualizado.profesional.telefono || undefined,
        meta: { ...metaBase, paciente: pacNombre },
      });
    }

    await notifyWaitlistForReleasedSlot({
      profesionalId: turnoActualizado.profesionalId,
      fechaHora: turnoActualizado.fechaHora,
      modalidad: turnoActualizado.modalidad as 'PRESENCIAL' | 'VIRTUAL',
      turnoId: turnoActualizado.id,
    });
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
  }

  res.json(success(turnoActualizado));
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

  const analysis = analyzePreconsulta({
    motivo: motivo.trim(),
    sintomas: sintomas.trim(),
    escalaDolor,
    escalaAnsiedad,
    inicioSintomas: inicioNormalizado,
    temperatura: temperaturaNormalizada,
    notasPaciente: notasNormalizadas,
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
      select: { notifEmail: true, notifWhatsapp: true, telefono: true },
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
    }
  }

  res.status(201).json(success({
    receta,
    shareText: recetaTexto,
  }));
}));

export { router as turnosRouter };
