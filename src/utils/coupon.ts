import prisma from '../lib/prisma';
import { AppError } from './response';

/** Result of validating and computing a coupon's discount. */
export interface ValidatedCoupon {
  /** The coupon's database ID */
  cuponId: string;
  /** Coupon type: `PORCENTAJE` (percentage) or `MONTO_FIJO` (fixed amount) */
  tipo: string;
  /** Original valor field from DB (always returned as a JS number) */
  valor: number;
  /** Human-readable description, may be null */
  descripcion: string | null;
  /** Original price before discount */
  montoOriginal: number;
  /** Discount amount in the same currency as montoOriginal */
  montoDescuento: number;
  /** Final price after discount, never below 0 */
  montoFinal: number;
}

/**
 * Calculate the discount amount for a coupon.
 *
 * @param montoOriginal - Base price before discount
 * @param tipo - `'PORCENTAJE'` for percentage off, anything else for fixed amount
 * @param valor - Numerical value: percentage (e.g. 10 for 10%) or fixed amount
 * @returns Object with `montoDescuento` and `montoFinal` (never negative)
 */
export function calculateDiscount(montoOriginal: number, tipo: string, valor: number): { montoDescuento: number; montoFinal: number } {
  let montoDescuento: number;
  if (tipo === 'PORCENTAJE') {
    montoDescuento = (montoOriginal * valor) / 100;
  } else {
    montoDescuento = valor;
  }
  const montoFinal = Math.max(0, montoOriginal - montoDescuento);
  return { montoDescuento, montoFinal };
}

/**
 * Look up a coupon by code, validate it belongs to the professional and is
 * still valid (active, not expired, not exhausted), then compute the discount.
 *
 * This does **not** increment usage count — that happens in the payment webhook
 * after the transaction is confirmed.
 *
 * @param codigo - Coupon code (case-insensitive)
 * @param turnoId - The turno the coupon is being applied to (for future scoping)
 * @param profesionalId - Must match the coupon's owning professional
 * @param precioBase - The base price to discount from
 * @throws {AppError} 400 with specific codes: INVALID_COUPON, INACTIVE_COUPON,
 *   COUPON_NOT_FOR_PROFESSIONAL, EXPIRED_COUPON, COUPON_EXHAUSTED
 */
export async function validateAndApplyCoupon(codigo: string, turnoId: string, profesionalId: string, precioBase: number): Promise<ValidatedCoupon> {
  const codigoUpper = codigo.toUpperCase();
  const cupon = await prisma.cupon.findUnique({ where: { codigo: codigoUpper } });

  if (!cupon) {
    throw new AppError(400, 'INVALID_COUPON', 'El código de cupón no es válido');
  }
  if (!cupon.activo) {
    throw new AppError(400, 'INACTIVE_COUPON', 'El cupón está inactivo');
  }
  if (cupon.profesionalId !== profesionalId) {
    throw new AppError(400, 'COUPON_NOT_FOR_PROFESSIONAL', 'El cupón no es válido para este profesional');
  }
  if (cupon.expiresAt && cupon.expiresAt < new Date()) {
    throw new AppError(400, 'EXPIRED_COUPON', 'El cupón ha expirado');
  }
  if (cupon.maxUsos && cupon.usosActuales >= cupon.maxUsos) {
    throw new AppError(400, 'COUPON_EXHAUSTED', 'El cupón ha alcanzado el máximo de usos');
  }

  const valor = Number(cupon.valor);
  const { montoDescuento, montoFinal } = calculateDiscount(precioBase, cupon.tipo, valor);

  return {
    cuponId: cupon.id,
    tipo: cupon.tipo,
    valor: Number(cupon.valor),
    descripcion: cupon.descripcion,
    montoOriginal: precioBase,
    montoDescuento,
    montoFinal,
  };
}