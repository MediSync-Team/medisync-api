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

  try {
    const data = await createMpPreference(preferenceData);

    const persistedPreference = await prisma.$transaction(async (tx) => {
      const currentPago = await tx.pago.findUnique({ where: { turnoId } });

      if (currentPago?.estado === 'APROBADO') {
        return { needsPayment: false as const };
      }

      const preferencePaymentData = {
        monto: precioFinal,
        montoNeto: precioFinal,
        estado: 'PENDIENTE' as const,
        mpPreferenciaId: data.id,
        cuponId,
        montoDescuento,
      };

      if (currentPago) {
        await tx.pago.update({ where: { turnoId }, data: preferencePaymentData });
      } else {
        await tx.pago.create({ data: { turnoId, ...preferencePaymentData } });
      }

      return { needsPayment: true as const };
    });

    if (!persistedPreference.needsPayment) {
      return { kind: 'already_paid' };
    }

    return { kind: 'preference', preferenciaId: data.id, initPoint: data.init_point };
  } catch (err) {
    console.error('Error creando preferencia MP:', err);
    throw new AppError(500, 'MP_ERROR', 'Error al crear preferencia de pago');
  }
}
