import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { sendNotification } from '../utils/notifications';
import { validateAndApplyCoupon } from '../utils/coupon';
import { redeemCouponUse } from '../utils/coupon-redemption';
import { isPayableTurnoState } from '../utils/turno-state';
import { Prisma } from '@prisma/client';

const router = Router();

interface MercadoPagoPreferenceResponse {
  id: string;
  init_point: string;
  error?: { message?: string };
  message?: string;
}

interface MercadoPagoWebhookBody {
  type?: string;
  data?: {
    id?: string | number;
  };
}

interface MercadoPagoPaymentResponse {
  external_reference?: string;
  status?: string;
  transaction_amount?: number;
}

function parseSignatureHeader(signature: string) {
  const parts = signature.split(',').map((p) => p.trim());
  let ts = '';
  let v1 = '';

  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key === 'ts') ts = value || '';
    if (key === 'v1') v1 = value || '';
  }

  return { ts, v1 };
}

function isValidWebhookSignature(req: any, dataId: string): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const signatureHeader = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  if (typeof signatureHeader !== 'string' || typeof requestId !== 'string') {
    return false;
  }

  const { ts, v1 } = parseSignatureHeader(signatureHeader);
  if (!ts || !v1) {
    return false;
  }

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return hash === v1;
}

router.post(
  '/crear-preferencia',
  authMiddleware('PACIENTE'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { turnoId, cuponCodigo } = req.body;

    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { profesional: { include: { especialidad: true } }, paciente: true, pago: true },
    });

    if (!turno) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }

    if (!turno.paciente || turno.paciente.usuarioId !== req.user!.userId) {
      throw new AppError(403, 'FORBIDDEN', 'Sin permisos para pagar este turno');
    }

    if (!isPayableTurnoState(turno.estado)) {
      throw new AppError(400, 'INVALID_STATE', 'El turno no admite pagos en su estado actual');
    }

    if (turno.pago?.estado === 'APROBADO') {
      res.json(success({ necesitaPago: false, mensaje: 'El turno ya se encuentra abonado' }));
      return;
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
          update: {
            monto: 0,
            montoNeto: 0,
            estado: 'APROBADO',
            cuponId,
            montoDescuento,
          },
          create: {
            turnoId,
            monto: 0,
            montoNeto: 0,
            estado: 'APROBADO',
            cuponId,
            montoDescuento,
          },
        });

        if (turno.estado === 'RESERVADO') {
          await tx.turno.update({
            where: { id: turnoId },
            data: { estado: 'CONFIRMADO' },
          });
        }
      });

      res.json(success({
        necesitaPago: false,
        mensaje: 'Turno confirmado sin pago',
        estado: 'APROBADO',
      }));
      return;
    }

    const preferenceData = {
      items: [
        {
          title: `Consulta con ${turno.profesional.nombre} ${turno.profesional.apellido} - ${turno.profesional.especialidad.nombre}`,
          unit_price: precioFinal,
          quantity: 1,
          currency_id: 'ARS',
        },
      ],
      external_reference: turnoId,
      notification_url: `${process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`}/api/pagos/webhook`,
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
      const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(preferenceData),
      });

      const data = await response.json() as MercadoPagoPreferenceResponse;

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
        console.error('MP Error:', errorMsg);
        throw new AppError(400, 'MP_ERROR', errorMsg);
      }

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
          await tx.pago.update({
            where: { turnoId },
            data: preferencePaymentData,
          });
        } else {
          await tx.pago.create({
            data: {
              turnoId,
              ...preferencePaymentData,
            },
          });
        }

        return { needsPayment: true as const };
      });

      if (!persistedPreference.needsPayment) {
        res.json(success({ necesitaPago: false, mensaje: 'El turno ya se encuentra abonado' }));
        return;
      }

      res.json(success({
        necesitaPago: true,
        preferenciaId: data.id,
        initPoint: data.init_point,
        estado: 'PENDIENTE',
      }));
    } catch (err) {
      console.error('Error creando preferencia MP:', err);
      throw new AppError(500, 'MP_ERROR', 'Error al crear preferencia de pago');
    }
  })
);

router.post('/webhook', asyncHandler(async (req, res) => {
  const body = req.body as MercadoPagoWebhookBody;
  const type = body.type;
  const data = body.data;

  if (type === 'payment') {
    const paymentId = data?.id;

    if (!paymentId || !isValidWebhookSignature(req, String(paymentId))) {
      throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook no autorizado');
    }
    
    try {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Mercado Pago payment fetch failed with status ${response.status}`);
      }

      const payment = await response.json() as MercadoPagoPaymentResponse;
      const turnoId = payment.external_reference;

      if (turnoId && payment.status === 'approved') {
        let couponRedemptionWarning: {
          turnoId: string;
          pagoId: string;
          cuponId: string;
          mpPaymentId: string;
          redemption: 'exhausted' | 'missing';
        } | null = null;

        // Pago approval, coupon usage, and turno confirmation must commit together.
        const approved = await prisma.$transaction(async (tx) => {
          const turnoActual = await tx.turno.findUnique({
            where: { id: turnoId },
            include: {
              pago: true,
              paciente: true,
              profesional: true,
            },
          });

          if (!turnoActual || !isPayableTurnoState(turnoActual.estado)) {
            return {
              skipped: true as const,
              turnoEstado: turnoActual?.estado ?? 'MISSING',
            };
          }

          if (turnoActual.pago?.estado === 'APROBADO') {
            return { skipped: true as const, turnoEstado: turnoActual.estado };
          }

          const paymentData = {
            estado: 'APROBADO' as const,
            mpPaymentId: String(paymentId),
            mpStatus: payment.status,
          };
          const amount = Number(payment.transaction_amount || 0);
          let pago = turnoActual.pago;

          if (pago) {
            const updated = await tx.pago.updateMany({
              where: {
                turnoId,
                estado: { not: 'APROBADO' },
              },
              data: paymentData,
            });

            if (updated.count === 0) {
              return { skipped: true as const, turnoEstado: turnoActual.estado };
            }

            pago = await tx.pago.findUnique({ where: { turnoId } });
          } else {
            try {
              pago = await tx.pago.create({
                data: {
                  turnoId,
                  monto: amount,
                  montoNeto: amount,
                  ...paymentData,
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                return { skipped: true as const, turnoEstado: turnoActual.estado };
              }
              throw err;
            }
          }

          if (!pago) {
            return { skipped: true as const, turnoEstado: turnoActual.estado };
          }

          // Keep coupon usage tied to the one webhook that newly approves the payment.
          if (pago.cuponId) {
            const redemption = await redeemCouponUse(tx, pago.cuponId);
            if (redemption !== 'incremented') {
              couponRedemptionWarning = {
                turnoId,
                pagoId: pago.id,
                cuponId: pago.cuponId,
                mpPaymentId: String(paymentId),
                redemption,
              };
            }
          }

          const turno = await tx.turno.update({
            where: { id: turnoId },
            data: { estado: 'CONFIRMADO' },
            include: { paciente: true, profesional: true },
          });

          return { skipped: false as const, pago, turno };
        });

        if (approved.skipped) {
          if (approved.turnoEstado === 'MISSING' || !isPayableTurnoState(approved.turnoEstado)) {
            console.warn('[pagos] Ignoring approved payment for non-payable turno', {
              turnoId,
              turnoEstado: approved.turnoEstado,
              mpPaymentId: String(paymentId),
            });
          }
          res.json(success({ received: true }));
          return;
        }

        const { pago, turno } = approved;

        if (couponRedemptionWarning) {
          console.warn('[pagos] Coupon capacity exhausted after paid approval', couponRedemptionWarning);
        }

        try {
          await sendNotification(['EMAIL', 'WHATSAPP'], {
            event: 'TURNO_CONFIRMADO',
            title: 'Pago aprobado — Turno confirmado',
            message: `Tu pago fue aprobado y el turno del ${turno.fechaHora.toLocaleString('es-AR')} quedó confirmado.`,
            userEmail: turno.paciente?.email,
            userPhone: turno.paciente?.telefono,
            meta: {
              turnoId: turno.id,
              fechaHora: turno.fechaHora.toISOString(),
              profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
              modalidad: turno.modalidad,
              lugarAtencion: turno.profesional.lugarAtencion ?? undefined,
              pagoId: pago.id,
              mpPaymentId: paymentId,
            },
          });
        } catch (err) {
          console.error('Error enviando notificación de pago aprobado:', err);
        }
      }
    } catch (err) {
      console.error('Error procesando webhook:', err);
      throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Error procesando webhook de pago');
    }
  }

  res.json(success({ received: true }));
}));

router.get('/estado/:turnoId', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const turno = await prisma.turno.findUnique({
    where: { id: req.params.turnoId },
    include: { paciente: true, profesional: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const userId = req.user!.userId;
  const hasAccess = turno.paciente?.usuarioId === userId || turno.profesional.usuarioId === userId;
  if (!hasAccess) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para ver este pago');
  }

  const pago = await prisma.pago.findUnique({
    where: { turnoId: req.params.turnoId },
  });

  if (!pago) {
    res.json(success({ estado: null }));
    return;
  }

  res.json(success({
    estado: pago.estado,
    monto: pago.monto,
    necesitaPago: pago.estado !== 'APROBADO',
    initPoint: pago.estado !== 'APROBADO' ? `/pago?turno=${req.params.turnoId}` : null,
  }));
}));

router.post('/confirmar-pago', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const turnoId = req.query.turnoId as string;

  if (!turnoId) {
    throw new AppError(400, 'MISSING_PARAM', 'turnoId es requerido');
  }

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { paciente: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (!turno.paciente || turno.paciente.usuarioId !== req.user!.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para confirmar este pago');
  }

  const pago = await prisma.pago.findUnique({
    where: { turnoId },
  });

  let turnoEstado = turno.estado;
  const canConfirmTurno = isPayableTurnoState(turno.estado);

  if (pago?.estado === 'APROBADO' && turno.estado !== 'CONFIRMADO' && canConfirmTurno) {
    await prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
    turnoEstado = 'CONFIRMADO';
  }

  res.json(success({
    confirmed: pago?.estado === 'APROBADO' && canConfirmTurno,
    estado: pago?.estado || null,
    turnoEstado,
  }));
}));

export { router as pagosRouter };
