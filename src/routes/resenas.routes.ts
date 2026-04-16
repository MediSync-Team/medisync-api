import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

// POST /api/resenas — paciente califica un turno completado
router.post('/', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId, rating, comentario } = req.body;

  if (!turnoId || typeof rating !== 'number' || rating < 1 || rating > 5) {
    throw new AppError(400, 'VALIDATION_ERROR', 'turnoId y rating (1-5) son requeridos');
  }

  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');

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
  const { page = '1', limit = '10' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(50, Number(limit));
  const skip = (p - 1) * l;

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
    pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) },
    stats: {
      promedio: aggregate._avg.rating ? Number(aggregate._avg.rating.toFixed(1)) : null,
      total: aggregate._count.rating,
    },
  }));
}));

// GET /api/resenas/mi-resena/:turnoId — si el paciente ya calificó ese turno
router.get('/mi-resena/:turnoId', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');

  const resena = await prisma.resena.findFirst({
    where: { turnoId: req.params.turnoId, pacienteId: paciente.id },
  });

  res.json(success(resena || null));
}));

export { router as resenasRouter };
