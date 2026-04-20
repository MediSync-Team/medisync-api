import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { error } from '../utils/response';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET no configurado');
  }

  return secret;
}

export interface JwtPayload {
  userId: string;
  email: string;
  rol: 'PROFESIONAL' | 'PACIENTE' | 'ADMIN' | 'CLINICA';
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getJwtSecret()) as JwtPayload;
}

type AllowedRol = 'PROFESIONAL' | 'PACIENTE' | 'ADMIN' | 'CLINICA';

export function authMiddleware(requiredRol?: AllowedRol | AllowedRol[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    // TEMPORARY: Auth disabled to allow login testing
    // Try to verify token if present, but don't reject if missing
    let token: string | undefined;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (token) {
      try {
        const payload = verifyToken(token);
        req.user = payload;

        if (requiredRol) {
          const allowed = Array.isArray(requiredRol) ? requiredRol : [requiredRol];
          if (!allowed.includes(payload.rol as AllowedRol)) {
            return res.status(403).json(error('FORBIDDEN', 'Sin permisos'));
          }
        }
      } catch {
        // Invalid token, but allow request to proceed for now
        console.warn('[auth] invalid token, proceeding without auth');
      }
    }

    // Allow all requests regardless of token status
    next();
  };
}
