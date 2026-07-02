import { EstadoTurno } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { notifyWaitlistForReleasedSlot } from '../waitlist.service';
import { refundPagoForTurno } from '../pagos/refund.service';
import { formatClinicDateTimeEs } from '../../utils/clinic-time';
import { canTransitionTurnoState } from '../../utils/turno-state';
import {
  assertTurnoAccess,
  canCancelTurno,
  getTurnoStatusResponse,
  notifyTurnoUser,
} from './turno-helpers';

type TurnoStatusResponse = NonNullable<Awaited<ReturnType<typeof getTurnoStatusResponse>>>;

export interface CambiarEstadoInput {
  turnoId: string;
  userId: string;
  estado?: EstadoTurno;
  notasCancelacion?: string;
}

export interface CambiarEstadoResult {
  turno: TurnoStatusResponse;
  /** Whether the caller should fire post-response Google Calendar cancel sync. */
  fireCancelSync: boolean;
}

/**
 * Apply a state transition to a turno (cancel / confirm / complete …).
 *
 * Enforces ownership, the {@link canTransitionTurnoState} machine and the
 * patient cancellation window, performs the cancellation side effects
 * (notifications, waitlist release, professional audit entry) atomically with
 * respect to the response, and reports whether calendar cancel-sync should run.
 */
export async function cambiarEstadoTurno(input: CambiarEstadoInput): Promise<CambiarEstadoResult> {
  const { turnoId, userId, estado, notasCancelacion } = input;

  const validEstados = Object.values(EstadoTurno);
  if (estado && !validEstados.includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Estado de turno invalido');
  }

  const { turno: turnoActual, isPacienteOwner, isProfesionalOwner } = await assertTurnoAccess(turnoId, userId);

  if (isPacienteOwner && estado && estado !== 'CANCELADO') {
    throw new AppError(403, 'FORBIDDEN', 'El paciente solo puede cancelar su turno');
  }

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para modificar este turno');
  }

  if (estado === 'CANCELADO' && turnoActual.estado === 'CANCELADO') {
    const turnoCancelado = await getTurnoStatusResponse(turnoId);
    return { turno: turnoCancelado!, fireCancelSync: false };
  }

  if (estado && estado !== turnoActual.estado) {
    if (!canTransitionTurnoState(turnoActual.estado, estado)) {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', `No se puede cambiar el estado de ${turnoActual.estado} a ${estado}`);
    }
  }

  if (isPacienteOwner && estado === 'CANCELADO' && !canCancelTurno(turnoActual.fechaHora)) {
    throw new AppError(
      422,
      'CANCELLATION_WINDOW_EXCEEDED',
      `Solo podes cancelar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  let cancellationSideEffectsEnabled = false;
  let turnoActualizado: TurnoStatusResponse;

  if (estado === 'CANCELADO') {
    const result = await prisma.turno.updateMany({
      where: {
        id: turnoId,
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      data: { estado: 'CANCELADO', notasCancelacion },
    });

    if (result.count === 0) {
      const latestTurno = await getTurnoStatusResponse(turnoId);

      if (latestTurno?.estado === 'CANCELADO') {
        return { turno: latestTurno, fireCancelSync: false };
      }

      throw new AppError(
        409,
        'INVALID_STATE_TRANSITION',
        `No se puede cambiar el estado de ${latestTurno?.estado ?? turnoActual.estado} a CANCELADO`
      );
    }

    const updatedAfterCancel = await getTurnoStatusResponse(turnoId);
    if (!updatedAfterCancel) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }

    turnoActualizado = updatedAfterCancel;
    cancellationSideEffectsEnabled = true;
  } else {
    turnoActualizado = await prisma.turno.update({
      where: { id: turnoId },
      data: { estado, notasCancelacion },
      include: {
        paciente: true,
        profesional: { include: { especialidad: true } },
      },
    });
  }

  const metaBase = {
    turnoId: turnoActualizado.id,
    fechaHora: turnoActualizado.fechaHora.toISOString(),
    profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
    especialidad: turnoActualizado.profesional.especialidad.nombre,
    modalidad: turnoActualizado.modalidad,
    lugarAtencion: turnoActualizado.lugarAtencion ?? turnoActualizado.profesional.lugarAtencion ?? undefined,
    linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
  };

  if (estado === 'CANCELADO' && cancellationSideEffectsEnabled) {
    // Reembolso automático del pago aprobado (total). Best-effort: si MP falla,
    // la cancelación igual sale y el reembolso se reintenta vía
    // POST /pagos/:turnoId/reembolsar o se reconcilia por webhook.
    try {
      const refund = await refundPagoForTurno(turnoId, { motivo: notasCancelacion });
      if (refund === 'failed') {
        console.error('[turnos] Cancelación sin reembolso: reintentar manualmente', { turnoId });
      }
    } catch (err) {
      console.error('[turnos] Error inesperado reembolsando al cancelar', { turnoId, err });
    }

    // Notificar al paciente
    if (turnoActualizado.paciente) {
      await notifyTurnoUser(
        {
          notifEmail: turnoActualizado.paciente.notifEmail,
          notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
        },
        {
          event: 'TURNO_CANCELADO',
          title: 'Turno cancelado',
          message: `Tu turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue cancelado.`,
          userEmail: turnoActualizado.paciente.email,
          userPhone: turnoActualizado.paciente.telefono ?? undefined,
          meta: metaBase,
        },
        {
          usuarioId: turnoActualizado.paciente.usuarioId,
          tipo: 'TURNO_CANCELADO',
          titulo: 'Turno cancelado',
          cuerpo: `Tu turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue cancelado.`,
          link: '/dashboard/paciente',
        }
      );
    }

    // Notificar al profesional si lo canceló el paciente
    if (isPacienteOwner) {
      const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoActualizado.profesional.usuarioId } });
      const pacNombre = turnoActualizado.paciente
        ? `${turnoActualizado.paciente.nombre} ${turnoActualizado.paciente.apellido}`
        : 'Paciente sin cuenta';
      await notifyTurnoUser(
        {
          notifEmail: turnoActualizado.profesional.notifEmail,
          notifWhatsapp: turnoActualizado.profesional.notifWhatsapp,
        },
        {
          event: 'TURNO_CANCELADO',
          title: 'Turno cancelado por el paciente',
          message: `${pacNombre} canceló su turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)}.`,
          userEmail: profUsuario?.email,
          userPhone: turnoActualizado.profesional.telefono || undefined,
          meta: { ...metaBase, paciente: pacNombre },
        },
        {
          usuarioId: turnoActualizado.profesional.usuarioId,
          tipo: 'TURNO_CANCELADO',
          titulo: 'Turno cancelado',
          cuerpo: `${pacNombre} canceló su turno del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)}.`,
          link: '/dashboard',
        }
      );
    }

    await notifyWaitlistForReleasedSlot({
      profesionalId: turnoActualizado.profesionalId,
      fechaHora: turnoActualizado.fechaHora,
      modalidad: turnoActualizado.modalidad as 'PRESENCIAL' | 'VIRTUAL',
      turnoId: turnoActualizado.id,
    });

    if (isProfesionalOwner) {
      await prisma.auditoriaDisponibilidad.create({
        data: {
          profesionalId: turnoActualizado.profesionalId,
          tipoEvento: 'TURNO_CANCELADO_POR_PROFESIONAL',
          turnoId: turnoActualizado.id,
          detalle: { fechaHora: turnoActualizado.fechaHora.toISOString(), notasCancelacion, pacienteId: turnoActualizado.pacienteId },
        },
      }).catch(() => {});
    }
  }

  if (estado === 'CONFIRMADO' && turnoActualizado.paciente) {
    await notifyTurnoUser(
      {
        notifEmail: turnoActualizado.paciente.notifEmail,
        notifWhatsapp: turnoActualizado.paciente.notifWhatsapp,
      },
      {
        event: 'TURNO_CONFIRMADO',
        title: 'Turno confirmado',
        message: `Tu turno con ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} fue confirmado.`,
        userEmail: turnoActualizado.paciente.email,
        userPhone: turnoActualizado.paciente.telefono ?? undefined,
        meta: metaBase,
      },
      {
        usuarioId: turnoActualizado.paciente.usuarioId,
        tipo: 'TURNO_CONFIRMADO',
        titulo: 'Turno confirmado',
        cuerpo: `Tu turno con Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} del ${formatClinicDateTimeEs(turnoActualizado.fechaHora)} fue confirmado.`,
        link: '/dashboard/paciente',
      }
    );
  }

  return {
    turno: turnoActualizado,
    fireCancelSync: estado === 'CANCELADO' && cancellationSideEffectsEnabled,
  };
}
