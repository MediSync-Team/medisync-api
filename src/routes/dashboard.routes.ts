import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { findProfesionalByUserId } from '../utils/auth-helpers';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import {
  getClinicDayBoundsForInstant,
  getClinicDateTimeParts,
  getClinicMonthBounds,
  CLINIC_TIME_ZONE
} from '../utils/clinic-time';

const router = Router();

router.get('/dashboard', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const now = new Date();
  const { start: today, end: tomorrow } = getClinicDayBoundsForInstant(now);
  const parts = getClinicDateTimeParts(now);
  const { start: startOfMonth, end: endOfMonth } = getClinicMonthBounds(parts.year, parts.month);

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
        fechaHora: { gte: startOfMonth, lt: endOfMonth },
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
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const now = new Date();
  const mesesAtras = 6;
  const parts = getClinicDateTimeParts(now);

  // Single aggregation query instead of N+1 findMany per month
  let targetMonth = parts.month - mesesAtras + 1;
  let targetYear = parts.year;
  if (targetMonth <= 0) {
    targetYear -= Math.ceil(Math.abs(targetMonth) / 12) || 1;
    targetMonth = 12 + (targetMonth % 12);
  }
  const { start: sixMonthsAgo } = getClinicMonthBounds(targetYear, targetMonth);

  const [turnosPorEstado, pagosPorMes, totalTurnos, pacientesUnicos] = await Promise.all([
    // Group turnos by estado over the last 6 months
    prisma.turno.groupBy({
      by: ['estado'],
      where: {
        profesionalId: profesional.id,
        fechaHora: { gte: sixMonthsAgo },
      },
      _count: true,
    }),
    // Group pagos by month for revenue calculation
    prisma.pago.findMany({
      where: {
        turno: { profesionalId: profesional.id, fechaHora: { gte: sixMonthsAgo } },
        estado: 'APROBADO',
      },
      select: {
        monto: true,
        montoNeto: true,
        turno: { select: { fechaHora: true } },
      },
    }),
    prisma.turno.count({
      where: { profesionalId: profesional.id },
    }),
    prisma.turno.groupBy({
      by: ['pacienteId'],
      where: { profesionalId: profesional.id, pacienteId: { not: null } },
    }),
  ]);

  // Build monthly buckets from the flat pago results
  const monthMap = new Map<string, { bruto: number; neto: number }>();
  for (const pago of pagosPorMes) {
    const fecha = pago.turno.fechaHora;
    const key = fecha.toLocaleDateString('es-AR', { month: 'short', year: '2-digit', timeZone: CLINIC_TIME_ZONE });
    const entry = monthMap.get(key) ?? { bruto: 0, neto: 0 };
    entry.bruto += Number(pago.monto);
    entry.neto += Number(pago.montoNeto);
    monthMap.set(key, entry);
  }

  // Also get turno counts per month for the 6-month window
  const turnos6m = await prisma.turno.findMany({
    where: { profesionalId: profesional.id, fechaHora: { gte: sixMonthsAgo } },
    select: { estado: true, fechaHora: true },
  });

  const turnosPorMes: { mes: string; total: number; completados: number; cancelados: number; ausentes: number }[] = [];
  const ingresosPorMes: { mes: string; bruto: number; neto: number }[] = [];

  for (let i = mesesAtras - 1; i >= 0; i--) {
    let m = parts.month - i;
    let y = parts.year;
    if (m <= 0) {
      y -= Math.ceil(Math.abs(m) / 12) || 1;
      m = 12 + (m % 12);
    }
    const { start: startOfMonth, end: endOfMonth } = getClinicMonthBounds(y, m);
    const mesNombre = startOfMonth.toLocaleDateString('es-AR', { month: 'short', year: '2-digit', timeZone: CLINIC_TIME_ZONE });

    const monthTurnos = turnos6m.filter(t => t.fechaHora >= startOfMonth && t.fechaHora < endOfMonth);

    turnosPorMes.push({
      mes: mesNombre,
      total: monthTurnos.length,
      completados: monthTurnos.filter(t => t.estado === 'COMPLETADO').length,
      cancelados: monthTurnos.filter(t => t.estado === 'CANCELADO').length,
      ausentes: monthTurnos.filter(t => t.estado === 'AUSENTE').length,
    });

    const pagoEntry = monthMap.get(mesNombre) ?? { bruto: 0, neto: 0 };
    ingresosPorMes.push({
      mes: mesNombre,
      bruto: pagoEntry.bruto,
      neto: pagoEntry.neto,
    });
  }

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
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const { desde, hasta, estado } = req.query as Record<string, string>;

  const { page: pageNum, limit: pageSize, skip } = parsePagination(req, { limit: 20, maxLimit: 100 });

  // Build date range — default: last 12 months
  const now = new Date();
  const parts = getClinicDateTimeParts(now);

  let defaultDesdeMonth = parts.month - 11;
  let defaultDesdeYear = parts.year;
  if (defaultDesdeMonth <= 0) {
    defaultDesdeYear -= Math.ceil(Math.abs(defaultDesdeMonth) / 12) || 1;
    defaultDesdeMonth = 12 + (defaultDesdeMonth % 12);
  }
  const { start: defaultDesde } = getClinicMonthBounds(defaultDesdeYear, defaultDesdeMonth);
  const { end: defaultHasta } = getClinicMonthBounds(parts.year, parts.month);

  const fechaDesde = desde ? getClinicDayBoundsForInstant(new Date(desde + 'T12:00:00.000Z')).start : defaultDesde;
  const fechaHasta = hasta ? getClinicDayBoundsForInstant(new Date(hasta + 'T12:00:00.000Z')).end : defaultHasta;

  const whereBase = {
    turno: {
      profesionalId: profesional.id,
      fechaHora: { gte: fechaDesde, lt: fechaHasta },
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

  // Monthly summary — single aggregation query instead of 12 findMany calls
  const pagosAll = await prisma.pago.findMany({
    where: {
      turno: { profesionalId: profesional.id, fechaHora: { gte: defaultDesde } },
    },
    select: {
      monto: true,
      montoNeto: true,
      estado: true,
      turno: { select: { fechaHora: true } },
    },
  });

  const mesesResumenMap = new Map<string, { bruto: number; neto: number; cantidad: number }>();
  for (let i = 11; i >= 0; i--) {
    let m = parts.month - i;
    let y = parts.year;
    if (m <= 0) {
      y -= Math.ceil(Math.abs(m) / 12) || 1;
      m = 12 + (m % 12);
    }
    const { start, end } = getClinicMonthBounds(y, m);
    const mesKey = start.toLocaleDateString('es-AR', { month: 'short', year: '2-digit', timeZone: CLINIC_TIME_ZONE });
    const monthPagos = pagosAll.filter(p => {
      const d = new Date(p.turno.fechaHora);
      return d >= start && d < end && p.estado === 'APROBADO';
    });
    mesesResumenMap.set(mesKey, {
      bruto:    monthPagos.reduce((s, p) => s + Number(p.monto), 0),
      neto:     monthPagos.reduce((s, p) => s + Number(p.montoNeto), 0),
      cantidad: monthPagos.length,
    });
  }

  const mesesResumen = Array.from(mesesResumenMap.entries()).map(([mes, data]) => ({ mes, ...data }));

  // Totals for the filtered period
  const todosEnRango = await prisma.pago.findMany({
    where: {
      turno: { profesionalId: profesional.id, fechaHora: { gte: fechaDesde, lt: fechaHasta } },
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
    pagination: buildPaginationMeta(pageNum, pageSize, total),
    totales,
    mesesResumen,
  }));
}));

export { router as dashboardRouter };
