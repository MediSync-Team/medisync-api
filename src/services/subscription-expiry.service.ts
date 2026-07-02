import prisma from '../lib/prisma';

/**
 * Downgrade PRO professionals whose paid period lapsed (planVenceAt < now).
 * Runs hourly from the cron in `index.ts`.
 *
 * `mpSuscripcionId` is deliberately left untouched: if the preapproval is still
 * alive and a late payment arrives, the `authorized` webhook re-upgrades to PRO.
 * PRO rows with `planVenceAt: null` (granted manually) are never downgraded.
 */
export async function downgradeExpiredProPlans(): Promise<number> {
  const result = await prisma.profesional.updateMany({
    where: {
      plan: 'PRO',
      planVenceAt: { not: null, lt: new Date() },
    },
    data: {
      plan: 'FREE',
      planVenceAt: null,
    },
  });

  if (result.count > 0) {
    console.log(`[suscripciones] ${result.count} plan(es) PRO vencido(s) bajado(s) a FREE`);
  }

  return result.count;
}
