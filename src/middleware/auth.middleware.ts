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
  rol: 'PROFESIONAL' | 'PACIENTE' | 'ADMIN';
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

export function authMiddleware(requiredRol?: 'PROFESIONAL' | 'PACIENTE' | 'ADMIN') {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json(error('UNAUTHORIZED', 'Token requerido'));
    }

    try {
      const token = authHeader.split(' ')[1];
      const payload = verifyToken(token);
      req.user = payload;

      if (requiredRol && payload.rol !== requiredRol) {
        return res.status(403).json(error('FORBIDDEN', 'Sin permisos'));
      }

      next();
    } catch {
      return res.status(401).json(error('INVALID_TOKEN', 'Token inválido'));
    }
  };
}
