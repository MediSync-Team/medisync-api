import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const { especialidad, disponibles, precioMin, precioMax, page = 1, limit = 10 } = req.query;

  const where: any = { activo: true };

  if (especialidad) {
    where.especialidad = { nombre: { contains: String(especialidad), mode: 'insensitive' } };
  }

  if (precioMin || precioMax) {
    where.precioConsulta = {};
    if (precioMin) where.precioConsulta.gte = Number(precioMin);
    if (precioMax) where.precioConsulta.lte = Number(precioMax);
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [profesionales, total] = await Promise.all([
    prisma.profesional.findMany({
      where,
      include: {
        especialidad: true,
        disponibilidades: { where: { activo: true } },
      },
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.profesional.count({ where }),
  ]);

  res.json(success({
    profesionales,
    pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
  }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const profesional = await prisma.profesional.findUnique({
    where: { id: req.params.id },
    include: {
      especialidad: true,
      disponibilidades: { where: { activo: true } },
    },
  });

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  res.json(success(profesional));
}));

router.put('/:id', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const authReq = req as AuthRequest;
  const { nombre, apellido, bio, telefono, genero, lugarAtencion, precioConsulta, fotoUrl } = req.body;

  const profesionalOwner = await prisma.profesional.findUnique({ where: { usuarioId: authReq.user!.userId } });
  if (!profesionalOwner || profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para editar este perfil');
  }

  if (telefono && !/^[\d\s\-\+\(\)]{8,20}$/.test(telefono)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El teléfono tiene un formato inválido');
  }

  if (genero && !['MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO'].includes(genero)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El género debe ser MASCULINO, FEMENINO, OTRO o NO_ESPECIFICADO');
  }

  const profesional = await prisma.profesional.update({
    where: { id: req.params.id },
    data: { 
      nombre, 
      apellido, 
      bio, 
      telefono, 
      genero: genero || 'NO_ESPECIFICADO',
      lugarAtencion, 
      precioConsulta, 
      fotoUrl 
    },
  });

  res.json(success(profesional));
}));

router.post('/:id/disponibilidad', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { diaSemana, horaInicio, horaFin, modalidad } = req.body;

  const profesionalOwner = await prisma.profesional.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!profesionalOwner || profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para gestionar esta disponibilidad');
  }

  if (!Number.isInteger(diaSemana) || diaSemana < 0 || diaSemana > 6) {
    throw new AppError(400, 'VALIDATION_ERROR', 'diaSemana debe estar entre 0 y 6');
  }

  if (!/^\d{2}:\d{2}$/.test(horaInicio) || !/^\d{2}:\d{2}$/.test(horaFin) || horaInicio >= horaFin) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Rango horario invalido');
  }

  const disponibilidad = await prisma.disponibilidad.create({
    data: {
      profesionalId: req.params.id,
      diaSemana,
      horaInicio,
      horaFin,
      modalidad: modalidad || 'PRESENCIAL',
    },
  });

  res.status(201).json(success(disponibilidad));
}));

router.get('/:id/disponibilidad', asyncHandler(async (req, res) => {
  const disponibilidades = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.id, activo: true },
  });

  res.json(success(disponibilidades));
}));

router.delete('/:id/disponibilidad/:dispId', authMiddleware('PROFESIONAL'), asyncHandler(async (req, res) => {
  const authReq = req as AuthRequest;
  const profesionalOwner = await prisma.profesional.findUnique({ where: { usuarioId: authReq.user!.userId } });
  if (!profesionalOwner || profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para eliminar esta disponibilidad');
  }

  const deleted = await prisma.disponibilidad.deleteMany({
    where: { id: req.params.dispId, profesionalId: req.params.id },
  });

  if (deleted.count === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Disponibilidad no encontrada');
  }

  res.json(success({ deleted: true }));
}));

router.get('/:id/slots-disponibles', asyncHandler(async (req, res) => {
  const { fecha, modalidad } = req.query;
  const fechaDate = new Date(String(fecha));
  const diaSemana = fechaDate.getDay();

  const disponibilidad = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.id, diaSemana, activo: true },
  });

  const turnosOcupados = await prisma.turno.findMany({
    where: {
      profesionalId: req.params.id,
      fechaHora: { gte: fechaDate, lt: new Date(fechaDate.getTime() + 86400000) },
      estado: { notIn: ['CANCELADO'] },
    },
  });

  const slots: { hora: string; disponible: boolean }[] = [];

  disponibilidad.forEach((disp) => {
    if (modalidad && disp.modalidad !== modalidad && disp.modalidad !== 'AMBOS') return;

    let [h, m] = disp.horaInicio.split(':').map(Number);
    const [hf, mf] = disp.horaFin.split(':').map(Number);

    while (h < hf || (h === hf && m < mf)) {
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const slotDate = new Date(fechaDate);
      slotDate.setHours(h, m, 0, 0);

      const ocupado = turnosOcupados.some((t) => t.fechaHora.getTime() === slotDate.getTime());

      slots.push({ hora: horaStr, disponible: !ocupado });

      m += 30;
      if (m >= 60) { h++; m -= 60; }
    }
  });

  res.json(success(slots));
}));

export { router as profesionalesRouter };
