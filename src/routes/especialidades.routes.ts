import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success } from '../utils/response';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const especialidades = await prisma.especialidad.findMany({
    orderBy: { nombre: 'asc' },
  });

  res.json(success(especialidades));
}));

export { router as especialidadesRouter };
