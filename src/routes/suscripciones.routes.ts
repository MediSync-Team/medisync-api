import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

async function getProfesionalIdByUsuario(usuarioId: string): Promise<string | null> {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId } });
  return profesional?.id || null;
}

// GET /suscripciones/estado — get subscription status for professional
router.get(
  '/estado',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const profesional = await prisma.profesional.findUnique({
      where: { id: profesionalId },
      select: { plan: true, planVenceAt: true, mpSuscripcionId: true },
    });

    if (!profesional) {
      throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
    }

    // Count turnos this month (not CANCELADO)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const turnosEsteMes = await prisma.turno.count({
      where: {
        profesionalId,
        fechaHora: { gte: startOfMonth },
        estado: { notIn: ['CANCELADO'] },
      },
    });

    const limiteTurnos = 20;
    const turnosRestantes = Math.max(0, limiteTurnos - turnosEsteMes);

    res.json(success({
      plan: profesional.plan,
      turnosEsteMes,
      limiteTurnos,
      turnosRestantes,
      planVenceAt: profesional.planVenceAt ? profesional.planVenceAt.toISOString() : null,
      mpSuscripcionId: profesional.mpSuscripcionId,
    }));
  })
);

// POST /suscripciones/iniciar — start subscription to PRO plan
router.post(
  '/iniciar',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const profesional = await prisma.profesional.findUnique({
      where: { id: profesionalId },
      include: { usuario: true },
    });

    if (!profesional || !profesional.usuario) {
      throw new AppError(404, 'NOT_FOUND', 'Profesional o usuario no encontrado');
    }

    try {
      const response = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          reason: 'MediSync Pro - Suscripción mensual',
          auto_recurring: {
            frequency: 1,
            frequency_type: 'months',
            transaction_amount: 20000,
            currency_id: 'ARS',
          },
          back_url: `${process.env.FRONTEND_URL}/dashboard`,
          payer_email: profesional.usuario.email,
        }),
      });

      const data = await response.json() as any;

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
        console.error('MP Preapproval Error:', errorMsg);
        throw new AppError(400, 'MP_ERROR', errorMsg);
      }

      // Save preapproval ID
      await prisma.profesional.update({
        where: { id: profesionalId },
        data: { mpSuscripcionId: data.id },
      });

      res.json(success({ initPoint: data.init_point }));
    } catch (err) {
      console.error('Error iniciando suscripción MP:', err);
      throw new AppError(500, 'MP_ERROR', 'Error al iniciar suscripción');
    }
  })
);

// POST /suscripciones/cancelar — cancel subscription
router.post(
  '/cancelar',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const profesional = await prisma.profesional.findUnique({
      where: { id: profesionalId },
      select: { mpSuscripcionId: true },
    });

    if (!profesional || !profesional.mpSuscripcionId) {
      throw new AppError(400, 'NO_SUBSCRIPTION', 'No hay suscripción activa');
    }

    try {
      const response = await fetch(
        `https://api.mercadopago.com/preapproval/${profesional.mpSuscripcionId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({ status: 'cancelled' }),
        }
      );

      if (!response.ok) {
        throw new AppError(400, 'MP_ERROR', 'Error al cancelar en MercadoPago');
      }

      // Update profesional
      await prisma.profesional.update({
        where: { id: profesionalId },
        data: {
          plan: 'FREE',
          mpSuscripcionId: null,
          planVenceAt: null,
        },
      });

      res.json(success({ cancelled: true }));
    } catch (err) {
      console.error('Error cancelando suscripción:', err);
      throw new AppError(500, 'MP_ERROR', 'Error al cancelar suscripción');
    }
  })
);

// POST /suscripciones/webhook — webhook from MP
router.post('/webhook', asyncHandler(async (req, res) => {
  const body = req.body as any;
  const type = body.type;

  if (type === 'subscription_preapproval') {
    const mpSuscripcionId = body.data?.id;
    const status = body.data?.status;

    if (!mpSuscripcionId) {
      res.json(success({ received: true }));
      return;
    }

    try {
      const profesional = await prisma.profesional.findFirst({
        where: { mpSuscripcionId },
      });

      if (!profesional) {
        console.warn(`Webhook: Profesional no encontrado para mpSuscripcionId ${mpSuscripcionId}`);
        res.json(success({ received: true }));
        return;
      }

      if (status === 'authorized') {
        // Calculate next billing date (approximate: 30 days from now)
        const nextBilling = new Date();
        nextBilling.setDate(nextBilling.getDate() + 30);

        await prisma.profesional.update({
          where: { id: profesional.id },
          data: {
            plan: 'PRO',
            planVenceAt: nextBilling,
          },
        });
      } else if (status === 'cancelled' || status === 'paused') {
        await prisma.profesional.update({
          where: { id: profesional.id },
          data: {
            plan: 'FREE',
            planVenceAt: null,
          },
        });
      }
    } catch (err) {
      console.error('Error procesando webhook suscripción:', err);
    }
  }

  res.json(success({ received: true }));
}));

export { router as suscripcionesRouter };
