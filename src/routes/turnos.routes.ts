import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { EstadoTurno } from '@prisma/client';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

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

  const turnos = await prisma.turno.findMany({
    where: whereClause,
    include: { profesional: { include: { especialidad: true } } },
    orderBy: { fechaHora: tipo === 'pasados' ? 'desc' : 'asc' },
  });

  res.json(success(turnos));
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

  const turnos = await prisma.turno.findMany({
    where,
    include: { paciente: true },
    orderBy: { fechaHora: 'asc' },
  });

  res.json(success(turnos));
}));

router.get('/profesional/:profesionalId/slots-disponibles', asyncHandler(async (req, res) => {
  const { fecha, modalidad } = req.query;
  const fechaDate = new Date(String(fecha));
  const diaSemana = fechaDate.getDay();

  const disponibilidad = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.profesionalId, diaSemana, activo: true },
  });

  const turnosOcupados = await prisma.turno.findMany({
    where: {
      profesionalId: req.params.profesionalId,
      fechaHora: { gte: fechaDate, lt: new Date(fechaDate.getTime() + 86400000) },
      estado: { notIn: ['CANCELADO'] },
    },
  });

  const slots: { hora: string; disponible: boolean }[] = [];

  disponibilidad.forEach((disp) => {
    if (modalidad && disp.modalidad !== modalidad && disp.modalidad !== 'AMBOS') return;

    let [h, m] = disp.horaInicio.split(':').map(Number);
    const [hf, mf] = disp.horaFin.split(':').map(Number);

    while (h < hf || (h === hf && m < mf)) {
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const slotDate = new Date(fechaDate);
      slotDate.setHours(h, m, 0, 0);

      const ocupado = turnosOcupados.some((t) => t.fechaHora.getTime() === slotDate.getTime());

      slots.push({ hora: horaStr, disponible: !ocupado });

      m += 30;
      if (m >= 60) { h++; m -= 60; }
    }
  });

  res.json(success(slots));
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

    res.status(201).json(success({ turno: result, linkPago: null }));
  })
);

router.patch('/:id', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { estado, notasCancelacion } = req.body;

  const validEstados = Object.values(EstadoTurno);
  if (estado && !validEstados.includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Estado de turno invalido');
  }

  const { isPacienteOwner, isProfesionalOwner } = await assertTurnoAccess(req.params.id, req);

  if (isPacienteOwner && estado && estado !== 'CANCELADO') {
    throw new AppError(403, 'FORBIDDEN', 'El paciente solo puede cancelar su turno');
  }

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para modificar este turno');
  }

  const turno = await prisma.turno.update({
    where: { id: req.params.id },
    data: { estado, notasCancelacion },
  });

  res.json(success(turno));
}));

router.get('/:id/evolucion', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoAccess(req.params.id, req);

  const evolucion = await prisma.evolucion.findUnique({
    where: { turnoId: req.params.id },
    include: { turno: { include: { archivos: true } } },
  });

  res.json(success(evolucion));
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

export { router as turnosRouter };
