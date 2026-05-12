import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { findPacienteByUserId, findProfesionalByUserId } from '../utils/auth-helpers';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';

const router = Router();

// POST /api/resenas — paciente califica un turno completado
router.post('/', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId, rating, comentario } = req.body;

  if (!turnoId || typeof rating !== 'number' || rating < 1 || rating > 5) {
    throw new AppError(400, 'VALIDATION_ERROR', 'turnoId y rating (1-5) son requeridos');
  }

  const paciente = await findPacienteByUserId(req.user!.userId);

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { resena: true },
  });

  if (!turno) throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  if (turno.pacienteId !== paciente.id) throw new AppError(403, 'FORBIDDEN', 'No podés calificar este turno');
  if (turno.estado !== 'COMPLETADO') throw new AppError(400, 'INVALID_STATE', 'Solo podés calificar turnos completados');
  if (turno.resena) throw new AppError(409, 'ALREADY_EXISTS', 'Ya calificaste este turno');

  const resena = await prisma.resena.create({
    data: {
      turnoId,
      profesionalId: turno.profesionalId,
      pacienteId: paciente.id,
      rating: Math.round(rating),
      comentario: comentario?.trim() || null,
    },
    include: {
      paciente: { select: { nombre: true, apellido: true } },
    },
  });

  res.status(201).json(success(resena));
}));

// GET /api/resenas/profesional/:profesionalId — reseñas públicas de un profesional
router.get('/profesional/:profesionalId', asyncHandler(async (req, res) => {
  const { page: p, limit: l, skip } = parsePagination(req);

  const [resenas, total, aggregate] = await Promise.all([
    prisma.resena.findMany({
      where: { profesionalId: req.params.profesionalId },
      include: { paciente: { select: { nombre: true, apellido: true, fotoUrl: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: l,
    }),
    prisma.resena.count({ where: { profesionalId: req.params.profesionalId } }),
    prisma.resena.aggregate({
      where: { profesionalId: req.params.profesionalId },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  res.json(success({
    resenas,
    pagination: buildPaginationMeta(p, l, total),
    stats: {
      promedio: aggregate._avg.rating ? Number(aggregate._avg.rating.toFixed(1)) : null,
      total: aggregate._count.rating,
    },
  }));
}));

// GET /api/resenas/mi-resena/:turnoId — si el paciente ya calificó ese turno
router.get('/mi-resena/:turnoId', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await findPacienteByUserId(req.user!.userId);

  const resena = await prisma.resena.findFirst({
    where: { turnoId: req.params.turnoId, pacienteId: paciente.id },
  });

  res.json(success(resena || null));
}));

// GET /api/resenas/mis-resenas — profesional ve todas sus reseñas
router.get('/mis-resenas', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const { rating } = req.query;
  const { page: p, limit: l, skip } = parsePagination(req, { limit: 20 });

  const where: any = { profesionalId: profesional.id };
  if (rating && Number(rating) >= 1 && Number(rating) <= 5) {
    where.rating = Number(rating);
  }

  const [resenas, total, aggregate, distribucion] = await Promise.all([
    prisma.resena.findMany({
      where,
      include: {
        paciente: { select: { nombre: true, apellido: true, fotoUrl: true } },
        turno: { select: { fechaHora: true, modalidad: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: l,
    }),
    prisma.resena.count({ where }),
    prisma.resena.aggregate({
      where: { profesionalId: profesional.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    // Distribución por estrellas (1-5) — siempre sin filtro de rating
    prisma.resena.groupBy({
      by: ['rating'],
      where: { profesionalId: profesional.id },
      _count: { rating: true },
    }),
  ]);

  const distMap: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of distribucion) { distMap[d.rating] = d._count.rating; }

  res.json(success({
    resenas,
    pagination: buildPaginationMeta(p, l, total),
    stats: {
      promedio: aggregate._avg.rating ? Number(aggregate._avg.rating.toFixed(1)) : null,
      total: aggregate._count.rating,
      distribucion: distMap,
    },
  }));
}));

// PATCH /api/resenas/:id/respuesta — profesional responde una reseña
router.patch('/:id/respuesta', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { respuesta } = req.body;

  if (typeof respuesta !== 'string' || respuesta.trim().length < 5 || respuesta.trim().length > 2000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La respuesta debe tener entre 5 y 2000 caracteres');
  }

  const profesional = await findProfesionalByUserId(req.user!.userId);

  const resena = await prisma.resena.findUnique({ where: { id: req.params.id } });
  if (!resena) throw new AppError(404, 'NOT_FOUND', 'Reseña no encontrada');
  if (resena.profesionalId !== profesional.id) throw new AppError(403, 'FORBIDDEN', 'Sin permisos para responder esta reseña');

  const updated = await prisma.resena.update({
    where: { id: req.params.id },
    data: { respuesta: respuesta.trim(), respondidaAt: new Date() },
    include: { paciente: { select: { nombre: true, apellido: true, fotoUrl: true } } },
  });

  res.json(success(updated));
}));

// DELETE /api/resenas/:id/respuesta — profesional borra su respuesta
router.delete('/:id/respuesta', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const resena = await prisma.resena.findUnique({ where: { id: req.params.id } });
  if (!resena) throw new AppError(404, 'NOT_FOUND', 'Reseña no encontrada');
  if (resena.profesionalId !== profesional.id) throw new AppError(403, 'FORBIDDEN', 'Sin permisos');

  const updated = await prisma.resena.update({
    where: { id: req.params.id },
    data: { respuesta: null, respondidaAt: null },
  });

  res.json(success(updated));
}));

export { router as resenasRouter };
