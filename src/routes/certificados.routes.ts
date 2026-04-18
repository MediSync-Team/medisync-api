import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.post('/', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId, tipo, diagnostico, texto, diasReposo } = req.body;

  if (!turnoId || !diagnostico || !texto) {
    throw new AppError(400, 'VALIDATION_ERROR', 'turnoId, diagnostico y texto son requeridos');
  }

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { profesional: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (turno.estado !== 'COMPLETADO') {
    throw new AppError(400, 'INVALID_STATE', 'El turno no está completado');
  }

  if (turno.profesional.usuarioId !== req.user!.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para emitir certificado en este turno');
  }

  const certificado = await prisma.certificadoMedico.upsert({
    where: { turnoId },
    update: {
      tipo: tipo || 'CONSULTA',
      diagnostico,
      texto,
      diasReposo: diasReposo || null,
      emitidaAt: new Date(),
    },
    create: {
      turnoId,
      tipo: tipo || 'CONSULTA',
      diagnostico,
      texto,
      diasReposo: diasReposo || null,
    },
  });

  res.status(201).json(success(certificado));
}));

router.get('/turno/:turnoId', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const certificado = await prisma.certificadoMedico.findUnique({
    where: { turnoId: req.params.turnoId },
    include: {
      turno: {
        include: {
          profesional: {
            include: { especialidad: true },
          },
          paciente: true,
        },
      },
    },
  });

  if (!certificado) {
    throw new AppError(404, 'NOT_FOUND', 'Certificado no encontrado');
  }

  const userId = req.user!.userId;
  const isProfesional = certificado.turno.profesional.usuarioId === userId;
  const isPaciente = certificado.turno.paciente?.usuarioId === userId;

  if (!isProfesional && !isPaciente) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para ver este certificado');
  }

  res.json(success({
    ...certificado,
    turno: {
      fechaHora: certificado.turno.fechaHora,
      modalidad: certificado.turno.modalidad,
      profesional: {
        nombre: certificado.turno.profesional.nombre,
        apellido: certificado.turno.profesional.apellido,
        matricula: certificado.turno.profesional.matricula,
        fotoUrl: certificado.turno.profesional.fotoUrl,
        lugarAtencion: certificado.turno.profesional.lugarAtencion,
        telefono: certificado.turno.profesional.telefono,
        especialidad: {
          nombre: certificado.turno.profesional.especialidad.nombre,
        },
      },
      paciente: certificado.turno.paciente ? {
        nombre: certificado.turno.paciente.nombre,
        apellido: certificado.turno.paciente.apellido,
        email: certificado.turno.paciente.email,
        dni: certificado.turno.paciente.dni,
        fechaNacimiento: certificado.turno.paciente.fechaNacimiento,
        obraSocial: certificado.turno.paciente.obraSocial,
      } : null,
    },
  }));
}));

export { router as certificadosRouter };
