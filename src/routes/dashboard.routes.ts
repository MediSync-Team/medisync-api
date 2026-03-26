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

export { router as dashboardRouter };
