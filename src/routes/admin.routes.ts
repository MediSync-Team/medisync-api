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

// ── Analytics ─────────────────────────────────────────────────────────────
router.get('/analytics', asyncHandler(async (_req, res) => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1); // 12 months back

  // ── Revenue per month (last 12 months) ───────────────────────────────────
  const pagosAprobados = await prisma.pago.findMany({
    where: { estado: 'APROBADO', createdAt: { gte: start } },
    select: { monto: true, createdAt: true },
  });

  const revenueByMonth: Record<string, number> = {};
  const turnosByMonth:  Record<string, number> = {};
  for (let i = 11; i >= 0; i--) {
    const d    = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    revenueByMonth[key] = 0;
    turnosByMonth[key]  = 0;
  }
  for (const p of pagosAprobados) {
    const d   = new Date(p.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (revenueByMonth[key] !== undefined) revenueByMonth[key] += Number(p.monto);
  }

  // ── Turnos por mes ────────────────────────────────────────────────────────
  const turnosRecientes = await prisma.turno.findMany({
    where: { createdAt: { gte: start } },
    select: { createdAt: true },
  });
  for (const t of turnosRecientes) {
    const d   = new Date(t.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (turnosByMonth[key] !== undefined) turnosByMonth[key]++;
  }

  // ── Turnos por especialidad ───────────────────────────────────────────────
  const turnosPorEsp = await prisma.turno.groupBy({
    by: ['profesionalId'],
    _count: { id: true },
  });
  const profIds = turnosPorEsp.map(t => t.profesionalId);
  const profs   = await prisma.profesional.findMany({
    where: { id: { in: profIds } },
    select: { id: true, especialidad: { select: { nombre: true } } },
  });
  const espMap: Record<string, number> = {};
  const profEspMap = Object.fromEntries(profs.map(p => [p.id, p.especialidad.nombre]));
  for (const row of turnosPorEsp) {
    const esp = profEspMap[row.profesionalId] ?? 'Sin especialidad';
    espMap[esp] = (espMap[esp] ?? 0) + row._count.id;
  }
  const turnosPorEspecialidad = Object.entries(espMap)
    .map(([especialidad, total]) => ({ especialidad, total }))
    .sort((a, b) => b.total - a.total);

  // ── Top 10 profesionales ──────────────────────────────────────────────────
  const topTurnosRaw = await prisma.turno.groupBy({
    by: ['profesionalId'],
    where: { estado: 'COMPLETADO' },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  });
  const topIds = topTurnosRaw.map(r => r.profesionalId);

  const [topProfsData, topRevenue] = await Promise.all([
    prisma.profesional.findMany({
      where: { id: { in: topIds } },
      select: {
        id: true, nombre: true, apellido: true,
        especialidad: { select: { nombre: true } },
      },
    }),
    prisma.pago.groupBy({
      by: ['turnoId'],
      where: {
        estado: 'APROBADO',
        turno: { profesionalId: { in: topIds } },
      },
      _sum: { monto: true },
    }).then(async (rows) => {
      // We need revenue per profesional — pivot via turno
      const turnoIds = rows.map(r => r.turnoId);
      const turnosConProf = await prisma.turno.findMany({
        where: { id: { in: turnoIds } },
        select: { id: true, profesionalId: true },
      });
      const turnoProf = Object.fromEntries(turnosConProf.map(t => [t.id, t.profesionalId]));
      const rev: Record<string, number> = {};
      for (const r of rows) {
        const pid = turnoProf[r.turnoId];
        if (pid) rev[pid] = (rev[pid] ?? 0) + Number(r._sum.monto ?? 0);
      }
      return rev;
    }),
  ]);

  const topProfMap = Object.fromEntries(topProfsData.map(p => [p.id, p]));
  const topProfesionales = topTurnosRaw.map(r => ({
    id:              r.profesionalId,
    nombre:          topProfMap[r.profesionalId]?.nombre ?? '',
    apellido:        topProfMap[r.profesionalId]?.apellido ?? '',
    especialidad:    topProfMap[r.profesionalId]?.especialidad.nombre ?? '',
    turnosCompletados: r._count.id,
    revenueTotal:    topRevenue[r.profesionalId] ?? 0,
  }));

  // ── Comisiones (5% sobre pagos aprobados como proxy) ─────────────────────
  const revenueTotal    = Object.values(revenueByMonth).reduce((a, b) => a + b, 0);
  const COMISION_RATE   = 0.05;
  const comisionesTotal = revenueTotal * COMISION_RATE;

  // ── Tasa de completado ────────────────────────────────────────────────────
  const [totalT, completados, cancelados] = await Promise.all([
    prisma.turno.count(),
    prisma.turno.count({ where: { estado: 'COMPLETADO' } }),
    prisma.turno.count({ where: { estado: 'CANCELADO' } }),
  ]);
  const tasaCompletado  = totalT > 0 ? Math.round((completados / totalT) * 100) : 0;
  const tasaCancelacion = totalT > 0 ? Math.round((cancelados  / totalT) * 100) : 0;

  res.json(success({
    revenueByMonth,
    turnosByMonth,
    turnosPorEspecialidad,
    topProfesionales,
    revenueTotal,
    comisionesTotal,
    tasaCompletado,
    tasaCancelacion,
  }));
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
