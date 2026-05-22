import { Router } from 'express';
import { asyncHandler, success } from '../utils/response';

const router = Router();

const OBRAS_SOCIALES = [
  'OSDE',
  'SWISS MEDICAL',
  'MEDIFÉ',
  'GALENO',
  'ACCORD SALUD',
  'IOMA',
  'PAMI',
  'OBRA SOCIAL BANCARIA (OSBA)',
  'OBRA SOCIAL DOCENTES (DOSUBA)',
  'OBRA SOCIAL EMPLEADOS DE COMERCIO (OSECAC)',
  'OBRA SOCIAL METALÚRGICOS (OSMERA)',
  'OBRA SOCIAL PERSONAL AERONÁUTICO (OSPAT)',
  'OBRA SOCIAL PERSONAL GRÁFICO (OSPECG)',
  'OBRA SOCIAL UNIÓN PERSONAL',
  'OBRA SOCIAL CAMIONEROS',
  'HOMINIS',
  'SANCOR SALUD',
  'JERÁRQUICOS SALUD',
  'LUIS PASTEUR',
  'OMINT',
  'PARTICULAR (SIN COBERTURA)',
];

router.get('/', asyncHandler(async (_req, res) => {
  res.json(success(OBRAS_SOCIALES));
}));

export { router as obrasSocialesRouter };
