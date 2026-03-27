import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const mp = require('mercadopago');

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
    const [key, value] = part.split('=');
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
    const { turnoId } = req.body;

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

    if (turno.estado !== 'RESERVADO' && turno.estado !== 'CONFIRMADO') {
      throw new AppError(400, 'INVALID_STATE', 'El turno no admite pagos en su estado actual');
    }

    if (turno.pago?.estado === 'APROBADO') {
      res.json(success({ necesitaPago: false, mensaje: 'El turno ya se encuentra abonado' }));
      return;
    }

    const precio = Number(turno.profesional.precioConsulta);

    if (precio <= 0) {
      await prisma.turno.update({
        where: { id: turnoId },
        data: { estado: 'CONFIRMADO' },
      });
      res.json(success({ 
        necesitaPago: false, 
        mensaje: 'Turno confirmado sin pago' 
      }));
      return;
    }

    const preferenceData = {
      items: [
        {
          title: `Consulta con ${turno.profesional.nombre} ${turno.profesional.apellido} - ${turno.profesional.especialidad.nombre}`,
          unit_price: precio,
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
      console.log('Creando preferencia...');
      console.log('Token:', process.env.MP_ACCESS_TOKEN ? 'presente' : 'ausente');
      console.log('Preference data:', JSON.stringify(preferenceData, null, 2));
      
      const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(preferenceData),
      });

      const data = await response.json() as MercadoPagoPreferenceResponse;
      console.log('Respuesta MP status:', response.status);
      console.log('Respuesta MP:', data);

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
        console.error('MP Error:', errorMsg);
        throw new AppError(400, 'MP_ERROR', errorMsg);
      }

      await prisma.pago.upsert({
        where: { turnoId },
        update: {
          monto: precio,
          montoNeto: precio * 0.9,
          estado: 'PENDIENTE',
          mpPreferenciaId: data.id,
        },
        create: {
          turnoId,
          monto: precio,
          montoNeto: precio * 0.9,
          estado: 'PENDIENTE',
          mpPreferenciaId: data.id,
        },
      });

      res.json(success({
        necesitaPago: true,
        preferenciaId: data.id,
        initPoint: data.init_point,
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

      const payment = await response.json() as MercadoPagoPaymentResponse;
      const turnoId = payment.external_reference;

      if (turnoId && payment.status === 'approved') {
        await prisma.pago.upsert({
          where: { turnoId },
          update: {
            estado: 'APROBADO',
            mpPaymentId: String(paymentId),
            mpStatus: payment.status,
          },
          create: {
            turnoId,
            monto: Number(payment.transaction_amount || 0),
            montoNeto: Number(payment.transaction_amount || 0) * 0.9,
            estado: 'APROBADO',
            mpPaymentId: String(paymentId),
            mpStatus: payment.status,
          },
        });

        await prisma.turno.update({
          where: { id: turnoId },
          data: { estado: 'CONFIRMADO' },
        });
      }
    } catch (err) {
      console.error('Error procesando webhook:', err);
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

  if (pago?.estado === 'APROBADO' && turno.estado !== 'CONFIRMADO') {
    await prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
  }

  res.json(success({ confirmed: pago?.estado === 'APROBADO', estado: pago?.estado || null }));
}));

export { router as pagosRouter };
