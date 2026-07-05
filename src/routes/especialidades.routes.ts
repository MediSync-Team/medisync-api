import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success } from '../utils/response';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const especialidades = await prisma.especialidad.findMany({
    orderBy: { nombre: 'asc' },
  });

  // Admin-editable but rarely changed; short max-age keeps client caches bounded
  // while SWR lets marketplace loads skip the round-trip most of the time.
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.json(success(especialidades));
}));

export { router as especialidadesRouter };
