import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { error } from '../utils/response';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface JwtPayload {
  userId: string;
  email: string;
  rol: 'PROFESIONAL' | 'PACIENTE';
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function authMiddleware(requiredRol?: 'PROFESIONAL' | 'PACIENTE') {
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
