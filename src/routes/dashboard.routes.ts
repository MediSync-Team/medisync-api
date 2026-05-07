import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.get('/dashboard', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const authReq = req as AuthRequest;

  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: authReq.user!.userId },
  });

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const [turnosHoy, proximosTurnos, stats] = await Promise.all([
    prisma.turno.count({
      where: {
        profesionalId: profesional.id,
        fechaHora: { gte: today, lt: tomorrow },
        estado: { notIn: ['CANCELADO'] },
      },
    }),
    prisma.turno.findMany({
      where: {
        profesionalId: profesional.id,
        fechaHora: { gte: today, lt: new Date(today.getTime() + 7 * 86400000) },
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      include: { paciente: true },
      orderBy: { fechaHora: 'asc' },
      take: 5,
    }),
    prisma.turno.groupBy({
      by: ['estado'],
      where: {
        profesionalId: profesional.id,
        fechaHora: { gte: startOfMonth, lte: endOfMonth },
      },
      _count: true,
    }),
  ]);

  const turnosCompletados = stats.find((s) => s.estado === 'COMPLETADO')?._count || 0;
  const turnosAusentes = stats.find((s) => s.estado === 'AUSENTE')?._count || 0;
  const totalTurnosMes = stats.reduce((acc, s) => acc + s._count, 0);
  const ausentismo = totalTurnosMes > 0 ? (turnosAusentes / totalTurnosMes) * 100 : 0;

  res.json(success({
    turnosHoy,
    proximosTurnos,
    resumen: {
      turnosMes: totalTurnosMes,
      ingresosMes: 0,
      ausentismo: Number(ausentismo.toFixed(1)),
      nuevosPacientes: 0,
    },
  }));
}));

router.get('/stats', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const authReq = req as AuthRequest;

  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: authReq.user!.userId },
  });

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const now = new Date();
  const mesesAtras = 6;
  const turnosPorMes: { mes: string; total: number; completados: number; cancelados: number; ausentes: number }[] = [];
  const ingresosPorMes: { mes: string; bruto: number; neto: number }[] = [];

  for (let i = mesesAtras - 1; i >= 0; i--) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

    const turnos = await prisma.turno.findMany({
      where: {
        profesionalId: profesional.id,
        fechaHora: { gte: startOfMonth, lte: endOfMonth },
      },
      include: { pago: true },
    });

    const completados = turnos.filter(t => t.estado === 'COMPLETADO').length;
    const cancelados = turnos.filter(t => t.estado === 'CANCELADO').length;
    const ausentes = turnos.filter(t => t.estado === 'AUSENTE').length;

    const mesNombre = startOfMonth.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });

    turnosPorMes.push({
      mes: mesNombre,
      total: turnos.length,
      completados,
      cancelados,
      ausentes,
    });

    const pagosAprobados = turnos.filter(t => t.pago?.estado === 'APROBADO');
    const bruto = pagosAprobados.reduce((acc, t) => acc + Number(t.pago?.monto || 0), 0);
    const neto = pagosAprobados.reduce((acc, t) => acc + Number(t.pago?.montoNeto || 0), 0);

    ingresosPorMes.push({ mes: mesNombre, bruto, neto });
  }

  const totalTurnos = await prisma.turno.count({
    where: { profesionalId: profesional.id },
  });

  const pacientesUnicos = await prisma.turno.groupBy({
    by: ['pacienteId'],
    where: { profesionalId: profesional.id, pacienteId: { not: null } },
  });

  res.json(success({
    turnosPorMes,
    ingresosPorMes,
    resumen: {
      totalTurnos,
      totalPacientes: pacientesUnicos.length,
    },
  }));
}));

// ── GET /profesional/pagos ───────────────────────────────────────────────────
// Lista de pagos recibidos por el profesional autenticado con filtros y resumen.
router.get('/pagos', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: req.user!.userId },
  });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');

  const { desde, hasta, estado, page = '1', limit = '20' } = req.query as Record<string, string>;

  const pageNum  = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
  const skip     = (pageNum - 1) * pageSize;

  // Build date range — default: last 12 months
  const now = new Date();
  const defaultDesde = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const fechaDesde = desde ? new Date(desde) : defaultDesde;
  const fechaHasta = hasta ? new Date(hasta + 'T23:59:59') : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const whereBase = {
    turno: {
      profesionalId: profesional.id,
      fechaHora: { gte: fechaDesde, lte: fechaHasta },
    },
    ...(estado && estado !== 'TODOS' ? { estado: estado as any } : {}),
  };

  const [pagos, total] = await Promise.all([
    prisma.pago.findMany({
      where: whereBase,
      include: {
        turno: {
          select: {
            id: true,
            fechaHora: true,
            modalidad: true,
            estado: true,
            paciente: { select: { nombre: true, apellido: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.pago.count({ where: whereBase }),
  ]);

  // Monthly summary — always last 12 months regardless of filter
  const mesesResumen: { mes: string; bruto: number; neto: number; cantidad: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    const pagosDelMes = await prisma.pago.findMany({
      where: {
        turno: { profesionalId: profesional.id, fechaHora: { gte: start, lte: end } },
        estado: 'APROBADO',
      },
      select: { monto: true, montoNeto: true },
    });
    mesesResumen.push({
      mes: start.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' }),
      bruto:    pagosDelMes.reduce((s, p) => s + Number(p.monto), 0),
      neto:     pagosDelMes.reduce((s, p) => s + Number(p.montoNeto), 0),
      cantidad: pagosDelMes.length,
    });
  }

  // Totals for the filtered period
  const todosEnRango = await prisma.pago.findMany({
    where: {
      turno: { profesionalId: profesional.id, fechaHora: { gte: fechaDesde, lte: fechaHasta } },
    },
    select: { monto: true, montoNeto: true, estado: true },
  });

  const totales = {
    bruto:     todosEnRango.filter(p => p.estado === 'APROBADO').reduce((s, p) => s + Number(p.monto), 0),
    neto:      todosEnRango.filter(p => p.estado === 'APROBADO').reduce((s, p) => s + Number(p.montoNeto), 0),
    pendiente: todosEnRango.filter(p => p.estado === 'PENDIENTE').reduce((s, p) => s + Number(p.monto), 0),
    aprobados: todosEnRango.filter(p => p.estado === 'APROBADO').length,
    pendientes: todosEnRango.filter(p => p.estado === 'PENDIENTE').length,
  };

  res.json(success({
    pagos,
    pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
    totales,
    mesesResumen,
  }));
}));

export { router as dashboardRouter };
