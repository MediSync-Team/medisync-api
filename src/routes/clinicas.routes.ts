import { Router } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import { sendNotification } from '../utils/notifications';
import { findProfesionalByUserId } from '../utils/auth-helpers';

const router = Router();

// ── Guard helper ─────────────────────────────────────────────────────────────
async function getClinicaOrFail(userId: string) {
  const clinica = await prisma.clinica.findUnique({
    where: { usuarioId: userId },
  });
  if (!clinica) throw new AppError(404, 'NOT_FOUND', 'Clínica no encontrada');
  return clinica;
}

// ── GET /api/clinicas/me ─────────────────────────────────────────────────────
// Perfil completo de la clínica del usuario autenticado con sus profesionales.
router.get('/me', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await prisma.clinica.findUnique({
    where: { usuarioId: req.user!.userId },
    include: {
      profesionales: {
        include: {
          especialidad: true,
          disponibilidades: { where: { activo: true } },
        },
        orderBy: { apellido: 'asc' },
      },
      invitaciones: {
        where: { estado: 'PENDIENTE' },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!clinica) throw new AppError(404, 'NOT_FOUND', 'Clínica no encontrada');
  res.json(success(clinica));
}));

// ── PUT /api/clinicas/me ─────────────────────────────────────────────────────
// Actualiza el perfil de la clínica.
router.put('/me', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);
  const { nombre, descripcion, logoUrl, direccion, telefono, website } = req.body;

  if (nombre !== undefined && (!nombre || !nombre.trim())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El nombre no puede estar vacío');
  }

  if (telefono !== undefined && telefono !== null && !/^[\d\s\-\+\(\)]{8,20}$/.test(telefono)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El teléfono tiene un formato inválido');
  }

  const updated = await prisma.clinica.update({
    where: { id: clinica.id },
    data: {
      nombre:      nombre      ?? clinica.nombre,
      descripcion: descripcion ?? clinica.descripcion,
      logoUrl:     logoUrl     ?? clinica.logoUrl,
      direccion:   direccion   ?? clinica.direccion,
      telefono:    telefono    ?? clinica.telefono,
      website:     website     ?? clinica.website,
    },
  });
  res.json(success(updated));
}));

// ── GET /api/clinicas/me/stats ───────────────────────────────────────────────
// Stats agregadas: turnos de hoy, del mes, ingresos, profesionales activos.
router.get('/me/stats', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);

  const profesionalesIds = (await prisma.profesional.findMany({
    where: { clinicaId: clinica.id },
    select: { id: true },
  })).map(p => p.id);

  if (profesionalesIds.length === 0) {
    res.json(success({ turnosHoy: 0, turnosMes: 0, ingresosMes: 0, profesionalesActivos: 0, cancelacionesMes: 0 }));
    return;
  }

  const now   = new Date();
  const hoyStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hoyEnd   = new Date(hoyStart.getTime() + 86_400_000);
  const mesStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mesEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [turnosHoy, turnosMes, cancelacionesMes, pagos, activos] = await Promise.all([
    prisma.turno.count({
      where: { profesionalId: { in: profesionalesIds }, fechaHora: { gte: hoyStart, lt: hoyEnd }, estado: { not: 'CANCELADO' } },
    }),
    prisma.turno.count({
      where: { profesionalId: { in: profesionalesIds }, fechaHora: { gte: mesStart, lt: mesEnd }, estado: { not: 'CANCELADO' } },
    }),
    prisma.turno.count({
      where: { profesionalId: { in: profesionalesIds }, fechaHora: { gte: mesStart, lt: mesEnd }, estado: 'CANCELADO' },
    }),
    prisma.pago.aggregate({
      where: {
        turno: { profesionalId: { in: profesionalesIds } },
        estado: 'APROBADO',
        createdAt: { gte: mesStart, lt: mesEnd },
      },
      _sum: { montoNeto: true },
    }),
    prisma.profesional.count({
      where: { clinicaId: clinica.id, activo: true },
    }),
  ]);

  res.json(success({
    turnosHoy,
    turnosMes,
    cancelacionesMes,
    ingresosMes: Number(pagos._sum.montoNeto ?? 0),
    profesionalesActivos: activos,
  }));
}));

// ── GET /api/clinicas/me/agenda ──────────────────────────────────────────────
// Agenda combinada de todos los profesionales de la clínica para una fecha.
router.get('/me/agenda', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);

  const fecha = req.query.fecha as string | undefined;
  const dateStart = fecha ? new Date(`${fecha}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
  const dateEnd   = new Date(dateStart.getTime() + 86_400_000);

  const turnos = await prisma.turno.findMany({
    where: {
      profesional: { clinicaId: clinica.id },
      fechaHora: { gte: dateStart, lt: dateEnd },
    },
    include: {
      profesional: { select: { id: true, nombre: true, apellido: true, fotoUrl: true, especialidad: { select: { nombre: true } } } },
      paciente:    { select: { id: true, nombre: true, apellido: true, email: true } },
    },
    orderBy: { fechaHora: 'asc' },
  });

  res.json(success(turnos));
}));

// ── POST /api/clinicas/me/invitar ────────────────────────────────────────────
// Envía una invitación por email a un profesional para que se una a la clínica.
router.post('/me/invitar', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);
  const { email } = req.body as { email: string };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Email inválido');
  }

  // Check if there's already an active invitation
  const existing = await prisma.invitacionClinica.findUnique({
    where: { clinicaId_email: { clinicaId: clinica.id, email } },
  });
  if (existing && existing.estado === 'PENDIENTE' && existing.expiresAt > new Date()) {
    throw new AppError(409, 'ALREADY_INVITED', 'Ya existe una invitación pendiente para ese email');
  }

  // If the professional is already in this clinic
  const profInClinica = await prisma.profesional.findFirst({
    where: { clinicaId: clinica.id, usuario: { email } },
  });
  if (profInClinica) {
    throw new AppError(409, 'ALREADY_MEMBER', 'El profesional ya pertenece a esta clínica');
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const invitacion = await prisma.invitacionClinica.upsert({
    where: { clinicaId_email: { clinicaId: clinica.id, email } },
    create: { clinicaId: clinica.id, email, expiresAt },
    update: { estado: 'PENDIENTE', expiresAt, token: undefined }, // reset expiry
  });

  // Send invitation email
  const acceptUrl = `${process.env.FRONTEND_URL ?? 'https://medisync-web.medisync.workers.dev'}/invitacion/${invitacion.token}`;
  sendNotification(['EMAIL'], {
    event: 'INVITACION_CLINICA',
    title: `Invitación de ${clinica.nombre}`,
    message: `Te invitaron a unirte a ${clinica.nombre} en MediSync. Aceptá la invitación aquí: ${acceptUrl}`,
    userEmail: email,
    meta: { clinica: clinica.nombre, token: invitacion.token, acceptUrl },
  }).catch(err => console.error('[clinica] invite email error:', err));

  res.status(201).json(success({ id: invitacion.id, email, expiresAt }));
}));

// ── GET /api/clinicas/me/invitaciones ────────────────────────────────────────
// Lista todas las invitaciones de la clínica.
router.get('/me/invitaciones', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);
  const invitaciones = await prisma.invitacionClinica.findMany({
    where: { clinicaId: clinica.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(success(invitaciones));
}));

// ── DELETE /api/clinicas/me/invitaciones/:id ─────────────────────────────────
// Cancela una invitación pendiente.
router.delete('/me/invitaciones/:id', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);
  const inv = await prisma.invitacionClinica.findUnique({ where: { id: req.params.id } });
  if (!inv || inv.clinicaId !== clinica.id) throw new AppError(404, 'NOT_FOUND', 'Invitación no encontrada');

  await prisma.invitacionClinica.update({ where: { id: inv.id }, data: { estado: 'EXPIRADA' } });
  res.json(success({ cancelled: true }));
}));

// ── DELETE /api/clinicas/me/profesionales/:profId ────────────────────────────
// Desvincula un profesional de la clínica.
router.delete('/me/profesionales/:profId', authMiddleware('CLINICA'), asyncHandler(async (req: AuthRequest, res) => {
  const clinica = await getClinicaOrFail(req.user!.userId);
  const prof = await prisma.profesional.findUnique({ where: { id: req.params.profId } });
  if (!prof || prof.clinicaId !== clinica.id) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado en esta clínica');

  await prisma.profesional.update({ where: { id: prof.id }, data: { clinicaId: null } });
  res.json(success({ removed: true }));
}));

// ── GET /api/clinicas/invitaciones/:token ────────────────────────────────────
// Devuelve los datos de una invitación por token (usado en la página de aceptar).
router.get('/invitaciones/:token', asyncHandler(async (req, res) => {
  const inv = await prisma.invitacionClinica.findUnique({
    where: { token: req.params.token },
    include: { clinica: { select: { nombre: true, descripcion: true, logoUrl: true, direccion: true } } },
  });
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invitación no encontrada');
  if (inv.expiresAt < new Date()) {
    await prisma.invitacionClinica.update({ where: { id: inv.id }, data: { estado: 'EXPIRADA' } });
    throw new AppError(410, 'EXPIRED', 'La invitación expiró');
  }
  res.json(success(inv));
}));

// ── POST /api/clinicas/invitaciones/:token/aceptar ───────────────────────────
// El profesional autenticado acepta la invitación y queda vinculado a la clínica.
router.post('/invitaciones/:token/aceptar', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const inv = await prisma.invitacionClinica.findUnique({
    where: { token: req.params.token },
    include: { clinica: true },
  });
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invitación no encontrada');
  if (inv.estado !== 'PENDIENTE') throw new AppError(409, 'INVALID_STATE', 'La invitación ya fue procesada');
  if (inv.expiresAt < new Date()) throw new AppError(410, 'EXPIRED', 'La invitación expiró');

  // Verify email matches authenticated user
  if (inv.email !== req.user!.email) {
    throw new AppError(403, 'FORBIDDEN', 'Esta invitación no corresponde a tu email');
  }

  const profesional = await findProfesionalByUserId(req.user!.userId);

  await prisma.$transaction([
    prisma.profesional.update({ where: { id: profesional.id }, data: { clinicaId: inv.clinicaId } }),
    prisma.invitacionClinica.update({ where: { id: inv.id }, data: { estado: 'ACEPTADA' } }),
  ]);

  res.json(success({ accepted: true, clinica: inv.clinica.nombre }));
}));

// ── POST /api/clinicas/invitaciones/:token/rechazar ──────────────────────────
// El profesional rechaza la invitación.
router.post('/invitaciones/:token/rechazar', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const inv = await prisma.invitacionClinica.findUnique({ where: { token: req.params.token } });
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invitación no encontrada');
  if (inv.estado !== 'PENDIENTE') throw new AppError(409, 'INVALID_STATE', 'La invitación ya fue procesada');
  if (inv.email !== req.user!.email) throw new AppError(403, 'FORBIDDEN', 'Esta invitación no corresponde a tu email');

  await prisma.invitacionClinica.update({ where: { id: inv.id }, data: { estado: 'RECHAZADA' } });
  res.json(success({ rejected: true }));
}));

export { router as clinicasRouter };
