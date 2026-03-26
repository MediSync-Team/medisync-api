import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const mp = require('mercadopago');

router.post(
  '/crear-preferencia',
  authMiddleware(),
  asyncHandler(async (req: AuthRequest, res) => {
    const { turnoId } = req.body;

    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { profesional: { include: { especialidad: true } }, paciente: true },
    });

    if (!turno) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }

    const precio = Number(turno.profesional.precioConsulta);

    if (precio <= 0) {
      await prisma.turno.update({
        where: { id: turnoId },
        data: { estado: 'CONFIRMADO' },
      });
      return res.json(success({ 
        necesitaPago: false, 
        mensaje: 'Turno confirmado sin pago' 
      }));
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
      notification_url: `${process.env.FRONTEND_URL}/api/pagos/webhook`,
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

      const data = await response.json();

      await prisma.pago.create({
        data: {
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
  const { type, data } = req.body;

  if (type === 'payment') {
    const paymentId = data.id;
    
    try {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        },
      });

      const payment = await response.json();
      const turnoId = payment.external_reference;

      if (turnoId && payment.status === 'approved') {
        await prisma.pago.update({
          where: { turnoId },
          data: {
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
  const pago = await prisma.pago.findUnique({
    where: { turnoId: req.params.turnoId },
  });

  if (!pago) {
    return res.json(success({ estado: null }));
  }

  res.json(success({
    estado: pago.estado,
    monto: pago.monto,
    necesitaPago: pago.estado !== 'APROBADO',
  }));
}));

export { router as pagosRouter };
