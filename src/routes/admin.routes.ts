import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// All admin routes require ADMIN role
router.use(authMiddleware('ADMIN'));

// ── Global stats ────────────────────────────────────────────────────────────
router.get('/stats', asyncHandler(async (_req, res) => {
  const [
    totalUsuarios,
    totalProfesionales,
    totalPacientes,
    totalTurnos,
    turnosPorEstado,
    totalEspecialidades,
    totalResenas,
    ingresosTotales,
    turnosUltimos30,
    registrosUltimos30,
  ] = await Promise.all([
    prisma.usuario.count(),
    prisma.profesional.count(),
    prisma.paciente.count(),
    prisma.turno.count(),
    prisma.turno.groupBy({ by: ['estado'], _count: { id: true } }),
    prisma.especialidad.count(),
    prisma.resena.count(),
    prisma.pago.aggregate({ where: { estado: 'APROBADO' }, _sum: { monto: true } }),
    prisma.turno.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.usuario.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
  ]);

  res.json(success({
    totalUsuarios,
    totalProfesionales,
    totalPacientes,
    totalTurnos,
    turnosPorEstado: Object.fromEntries(turnosPorEstado.map(e => [e.estado, e._count.id])),
    totalEspecialidades,
    totalResenas,
    ingresosAprobados: Number(ingresosTotales._sum.monto ?? 0),
    turnosUltimos30,
    registrosUltimos30,
  }));
}));

// ── Usuarios ────────────────────────────────────────────────────────────────
router.get('/usuarios', asyncHandler(async (req, res) => {
  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const skip  = (page - 1) * limit;
  const search = (req.query.search as string) || '';

  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { profesional: { OR: [
            { nombre: { contains: search, mode: 'insensitive' as const } },
            { apellido: { contains: search, mode: 'insensitive' as const } },
          ]}},
          { paciente: { OR: [
            { nombre: { contains: search, mode: 'insensitive' as const } },
            { apellido: { contains: search, mode: 'insensitive' as const } },
          ]}},
        ],
      }
    : {};

  const [usuarios, total] = await Promise.all([
    prisma.usuario.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        rol: true,
        createdAt: true,
        profesional: { select: { id: true, nombre: true, apellido: true, activo: true, especialidad: { select: { nombre: true } } } },
        paciente: { select: { id: true, nombre: true, apellido: true } },
      },
    }),
    prisma.usuario.count({ where }),
  ]);

  res.json(success({ usuarios, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
}));

// Toggle professional active state (suspend/unsuspend)
router.patch('/usuarios/:id/toggle-activo', asyncHandler(async (req, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.params.id },
    include: { profesional: true },
  });
  if (!usuario) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');
  if (!usuario.profesional) throw new AppError(400, 'BAD_REQUEST', 'Solo se puede suspender profesionales');

  const updated = await prisma.profesional.update({
    where: { usuarioId: req.params.id },
    data: { activo: !usuario.profesional.activo },
  });

  res.json(success({ activo: updated.activo }));
}));

// ── Profesionales ────────────────────────────────────────────────────────────
router.get('/profesionales', asyncHandler(async (req, res) => {
  const page  = Math.max(1, Number(req.query.page)  || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const skip  = (page - 1) * limit;
  const search = (req.query.search as string) || '';

  const where = search
    ? {
        OR: [
          { nombre: { contains: search, mode: 'insensitive' as const } },
          { apellido: { contains: search, mode: 'insensitive' as const } },
          { usuario: { email: { contains: search, mode: 'insensitive' as const } } },
          { especialidad: { nombre: { contains: search, mode: 'insensitive' as const } } },
        ],
      }
    : {};

  const [profesionales, total] = await Promise.all([
    prisma.profesional.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        especialidad: true,
        usuario: { select: { email: true, createdAt: true } },
        _count: { select: { turnos: true, resenas: true } },
      },
    }),
    prisma.profesional.count({ where }),
  ]);

  const ratings = await prisma.resena.groupBy({
    by: ['profesionalId'],
    where: { profesionalId: { in: profesionales.map(p => p.id) } },
    _avg: { rating: true },
    _count: { id: true },
  });
  const ratingMap = Object.fromEntries(ratings.map(r => [r.profesionalId, { avg: r._avg.rating, count: r._count.id }]));

  const result = profesionales.map(p => ({
    ...p,
    precioConsulta: Number(p.precioConsulta),
    ratingPromedio: ratingMap[p.id]?.avg ?? null,
    totalResenas: ratingMap[p.id]?.count ?? 0,
  }));

  res.json(success({ profesionales: result, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
}));

// ── Turnos ────────────────────────────────────────────────────────────────
router.get('/turnos', asyncHandler(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 20);
  const skip   = (page - 1) * limit;
  const estado = req.query.estado as string | undefined;
  const search = (req.query.search as string) || '';

  const where: any = {};
  if (estado) where.estado = estado;
  if (search) {
    where.OR = [
      { profesional: { nombre: { contains: search, mode: 'insensitive' } } },
      { profesional: { apellido: { contains: search, mode: 'insensitive' } } },
      { paciente:    { nombre: { contains: search, mode: 'insensitive' } } },
      { paciente:    { apellido: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [turnos, total] = await Promise.all([
    prisma.turno.findMany({
      where,
      skip,
      take: limit,
      orderBy: { fechaHora: 'desc' },
      include: {
        profesional: { select: { id: true, nombre: true, apellido: true, especialidad: { select: { nombre: true } } } },
        paciente:    { select: { id: true, nombre: true, apellido: true } },
        pago:        { select: { monto: true, estado: true } },
      },
    }),
    prisma.turno.count({ where }),
  ]);

  res.json(success({ turnos, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }));
}));

// ── Especialidades CRUD ───────────────────────────────────────────────────
router.post('/especialidades', asyncHandler(async (req, res) => {
  const { nombre, descripcion, icono } = req.body;
  if (!nombre?.trim()) throw new AppError(400, 'BAD_REQUEST', 'Nombre requerido');

  const existe = await prisma.especialidad.findFirst({ where: { nombre: { equals: nombre.trim(), mode: 'insensitive' } } });
  if (existe) throw new AppError(409, 'CONFLICT', 'Ya existe una especialidad con ese nombre');

  const especialidad = await prisma.especialidad.create({
    data: { nombre: nombre.trim(), descripcion: descripcion?.trim() || null, icono: icono?.trim() || null },
  });

  res.status(201).json(success(especialidad));
}));

router.put('/especialidades/:id', asyncHandler(async (req, res) => {
  const { nombre, descripcion, icono } = req.body;
  const existe = await prisma.especialidad.findUnique({ where: { id: req.params.id } });
  if (!existe) throw new AppError(404, 'NOT_FOUND', 'Especialidad no encontrada');

  if (nombre?.trim() && nombre.trim() !== existe.nombre) {
    const dup = await prisma.especialidad.findFirst({
      where: { nombre: { equals: nombre.trim(), mode: 'insensitive' }, NOT: { id: req.params.id } },
    });
    if (dup) throw new AppError(409, 'CONFLICT', 'Ya existe una especialidad con ese nombre');
  }

  const updated = await prisma.especialidad.update({
    where: { id: req.params.id },
    data: {
      ...(nombre?.trim()            && { nombre: nombre.trim() }),
      ...(descripcion !== undefined  && { descripcion: descripcion?.trim() || null }),
      ...(icono !== undefined        && { icono: icono?.trim() || null }),
    },
  });

  res.json(success(updated));
}));

router.delete('/especialidades/:id', asyncHandler(async (req, res) => {
  const existe = await prisma.especialidad.findUnique({ where: { id: req.params.id } });
  if (!existe) throw new AppError(404, 'NOT_FOUND', 'Especialidad no encontrada');

  const enUso = await prisma.profesional.count({ where: { especialidadId: req.params.id } });
  if (enUso > 0) throw new AppError(409, 'CONFLICT', `No se puede eliminar: ${enUso} profesional(es) la usan`);

  await prisma.especialidad.delete({ where: { id: req.params.id } });
  res.json(success({ deleted: true }));
}));

export { router as adminRouter };
