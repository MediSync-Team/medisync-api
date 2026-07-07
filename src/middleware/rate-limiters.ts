import { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

function logRateLimitHit(kind: string, req: Request) {
  console.warn(`[rate-limit] ${kind} hit`, {
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
  });
}

export function createGlobalLimiter(isProduction: boolean) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 2000 : 10000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    handler: (req: Request, res: Response) => {
      logRateLimitHit('global', req);
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_GLOBAL',
          message: 'Demasiadas solicitudes. Intenta nuevamente en unos minutos.',
        },
      });
    },
  });
}

export function createLoginRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: (req) => req.method === 'OPTIONS',
    handler: (req: Request, res: Response) => {
      logRateLimitHit('login', req);
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_LOGIN',
          message: 'Demasiados intentos fallidos. Intenta más tarde.',
        },
      });
    },
  });
}

export const loginRateLimiter = createLoginRateLimiter();
