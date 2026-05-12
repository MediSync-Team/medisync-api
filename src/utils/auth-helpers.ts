import { Response } from 'express';
import prisma from '../lib/prisma';
import { AppError } from './response';

/**
 * Set the JWT authentication cookie on the response.
 *
 * Uses httpOnly, sameSite=lax, and a 7-day maxAge.
 * The `secure` flag is computed per-request so it reflects the
 * current NODE_ENV at cookie-creation time rather than at module-load time.
 */
export function setTokenCookie(res: Response, token: string): void {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/**
 * Look up the profesional ID for a given usuario ID.
 * Returns `null` if the usuario is not a profesional (e.g. paciente, admin).
 * Use this when you need to check ownership without throwing.
 */
export async function getProfesionalIdByUsuario(usuarioId: string): Promise<string | null> {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId } });
  return profesional?.id ?? null;
}

/**
 * Find a profesional by usuario ID or throw 404.
 * Use this when the endpoint requires a profesional to exist.
 */
export async function findProfesionalByUserId(usuarioId: string) {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId } });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  return profesional;
}

/**
 * Find a paciente by usuario ID or throw 404.
 * Use this when the endpoint requires a paciente to exist.
 */
export async function findPacienteByUserId(usuarioId: string) {
  const paciente = await prisma.paciente.findUnique({ where: { usuarioId } });
  if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  return paciente;
}