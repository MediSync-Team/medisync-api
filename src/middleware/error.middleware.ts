import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { error } from '../utils/response';

export function errorHandler(
  err: Error & { statusCode?: number; code?: string },
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('❌ Error:', err);

  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error('[errorHandler] Prisma validation error details:', err.message);
    return res.status(400).json(error('VALIDATION_ERROR', `Error de validación: ${err.message}`));
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Error interno del servidor';

  res.status(statusCode).json(error(code, message));
}

