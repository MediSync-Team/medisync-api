import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { isPayableTurnoState } from '../../utils/turno-state';

export interface PagoQueryInput {
  userId: string;
  turnoId: string;
}

/** Return the pago estado for a turno the user can access (paciente or profesional). */
export async function getPagoEstado({ userId, turnoId }: PagoQueryInput) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { paciente: true, profesional: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const hasAccess = turno.paciente?.usuarioId === userId || turno.profesional.usuarioId === userId;
  if (!hasAccess) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para ver este pago');
  }

  const pago = await prisma.pago.findUnique({ where: { turnoId } });

  if (!pago) {
    return { estado: null };
  }

  return {
    estado: pago.estado,
    monto: pago.monto,
    necesitaPago: pago.estado !== 'APROBADO',
    initPoint: pago.estado !== 'APROBADO' ? `/pago?turno=${turnoId}` : null,
  };
}

/** Confirm a turno (→ CONFIRMADO) when its pago is APROBADO and the state allows it. */
export async function confirmarPago({ userId, turnoId }: PagoQueryInput) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { paciente: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (!turno.paciente || turno.paciente.usuarioId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para confirmar este pago');
  }

  const pago = await prisma.pago.findUnique({ where: { turnoId } });

  let turnoEstado = turno.estado;
  const canConfirmTurno = isPayableTurnoState(turno.estado);

  if (pago?.estado === 'APROBADO' && turno.estado !== 'CONFIRMADO' && canConfirmTurno) {
    await prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
    turnoEstado = 'CONFIRMADO';
  }

  return {
    confirmed: pago?.estado === 'APROBADO' && canConfirmTurno,
    estado: pago?.estado || null,
    turnoEstado,
  };
}
