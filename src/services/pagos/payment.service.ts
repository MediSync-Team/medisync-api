import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { validateAndApplyCoupon } from '../../utils/coupon';
import { redeemCouponUse } from '../../utils/coupon-redemption';
import { isPayableTurnoState } from '../../utils/turno-state';
import { createMpPreference } from './mercadopago';

export interface CreatePaymentPreferenceInput {
  userId: string;
  turnoId: string;
  cuponCodigo?: string;
  /** Absolute URL MercadoPago should call back on (built from the request by the handler). */
  notificationUrl: string;
}

export type CreatePaymentPreferenceResult =
  | { kind: 'already_paid' }
  | { kind: 'free_confirmed' }
  | { kind: 'preference'; preferenciaId: string; initPoint: string };

/**
 * Validate a turno, apply an optional coupon, and either confirm it for free,
 * report it already paid, or create a MercadoPago preference + persist the pago.
 */
export async function createPaymentPreference(input: CreatePaymentPreferenceInput): Promise<CreatePaymentPreferenceResult> {
  const { userId, turnoId, cuponCodigo, notificationUrl } = input;

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { profesional: { include: { especialidad: true } }, paciente: true, pago: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (!turno.paciente || turno.paciente.usuarioId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para pagar este turno');
  }

  if (!isPayableTurnoState(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'El turno no admite pagos en su estado actual');
  }

  if (turno.pago?.estado === 'APROBADO') {
    return { kind: 'already_paid' };
  }

  const precio = Number(turno.profesional.precioConsulta);
  let precioFinal = precio;
  let cuponId: string | null = null;
  let montoDescuento: number | null = null;

  // Validate and apply coupon if provided
  if (cuponCodigo) {
    const couponResult = await validateAndApplyCoupon(cuponCodigo, turnoId, turno.profesionalId, precio);
    precioFinal = couponResult.montoFinal;
    cuponId = couponResult.cuponId;
    montoDescuento = couponResult.montoDescuento;
  }

  if (precioFinal <= 0) {
    await prisma.$transaction(async (tx) => {
      const existingPago = await tx.pago.findUnique({ where: { turnoId } });
      const wasAlreadyApproved = existingPago?.estado === 'APROBADO';

      if (cuponId && !wasAlreadyApproved) {
        const redemption = await redeemCouponUse(tx, cuponId);
        if (redemption === 'exhausted') {
          throw new AppError(400, 'COUPON_EXHAUSTED', 'El cupón ha alcanzado el máximo de usos');
        }
        if (redemption === 'missing') {
          throw new AppError(400, 'INVALID_COUPON', 'El código de cupón no es válido');
        }
      }

      await tx.pago.upsert({
        where: { turnoId },
        update: { monto: 0, montoNeto: 0, estado: 'APROBADO', cuponId, montoDescuento },
        create: { turnoId, monto: 0, montoNeto: 0, estado: 'APROBADO', cuponId, montoDescuento },
      });

      if (turno.estado === 'RESERVADO') {
        await tx.turno.update({ where: { id: turnoId }, data: { estado: 'CONFIRMADO' } });
      }
    });

    return { kind: 'free_confirmed' };
  }

  const preferenceData: Record<string, unknown> = {
    items: [
      {
        title: `Consulta con ${turno.profesional.nombre} ${turno.profesional.apellido} - ${turno.profesional.especialidad.nombre}`,
        unit_price: precioFinal,
        quantity: 1,
        currency_id: 'ARS',
      },
    ],
    external_reference: turnoId,
    notification_url: notificationUrl,
    payer: {
      email: turno.paciente?.email || 'invitado@medisync.com',
      name: turno.paciente?.nombre,
      surname: turno.paciente?.apellido,
    },
    back_urls: {
      success: `${process.env.FRONTEND_URL}/pago-exitoso?turno=${turnoId}`,
      failure: `${process.env.FRONTEND_URL}/pago-fallido?turno=${turnoId}`,
      pending: `${process.env.FRONTEND_URL}/pago-pendiente?turno=${turnoId}`,
    },
  };

  // Reserve the pago row BEFORE calling MercadoPago so the DB is the source of
  // truth. If the MP call then fails, the reserved row simply has no
  // mpPreferenciaId — there is never a preference created on MP's side without a
  // matching DB record (MercadoPago has no preference-delete API to compensate).
  const reservation = await prisma.$transaction(async (tx) => {
    const currentPago = await tx.pago.findUnique({ where: { turnoId } });

    if (currentPago?.estado === 'APROBADO') {
      return { alreadyPaid: true as const };
    }

    const reservedData = {
      monto: precioFinal,
      montoNeto: precioFinal,
      estado: 'PENDIENTE' as const,
      cuponId,
      montoDescuento,
    };

    if (currentPago) {
      await tx.pago.update({ where: { turnoId }, data: reservedData });
    } else {
      await tx.pago.create({ data: { turnoId, ...reservedData } });
    }

    return { alreadyPaid: false as const };
  });

  if (reservation.alreadyPaid) {
    return { kind: 'already_paid' };
  }

  let data;
  try {
    data = await createMpPreference(preferenceData);
  } catch (err) {
    console.error('Error creando preferencia MP:', err);
    throw new AppError(500, 'MP_ERROR', 'Error al crear preferencia de pago');
  }

  // Attach the preference id. If this rare update fails the webhook still
  // reconciles the payment via external_reference = turnoId, so we don't fail
  // the request.
  try {
    await prisma.pago.update({ where: { turnoId }, data: { mpPreferenciaId: data.id } });
  } catch (err) {
    console.error('[pagos] No se pudo guardar mpPreferenciaId; el webhook reconciliará vía external_reference', {
      turnoId,
      mpPreferenciaId: data.id,
      err,
    });
  }

  return { kind: 'preference', preferenciaId: data.id, initPoint: data.init_point };
}
