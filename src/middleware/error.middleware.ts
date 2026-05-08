import { Request, Response, NextFunction } from 'express';
import { error } from '../utils/response';

export function errorHandler(
  err: Error & { statusCode?: number; code?: string },
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('❌ Error:', err);

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Error interno del servidor';

  res.status(statusCode).json(error(code, message));
}

