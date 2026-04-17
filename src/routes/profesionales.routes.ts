import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const {
    especialidad,
    precioMin,
    precioMax,
    modalidad,
    fecha,
    disponibleEstaSemana,
    orderBy: orderByParam,
    page = 1,
    limit = 10,
  } = req.query;

  const filterDisponible = disponibleEstaSemana === 'true';
  const pageNum  = Number(page);
  const limitNum = Number(limit);

  const where: any = { activo: true };

  if (especialidad) {
    where.especialidad = { nombre: { contains: String(especialidad), mode: 'insensitive' } };
  }

  if (precioMin || precioMax) {
    where.precioConsulta = {};
    if (precioMin) where.precioConsulta.gte = Number(precioMin);
    if (precioMax) where.precioConsulta.lte = Number(precioMax);
  }

  // Filter by modalidad: profesional must have at least one active disponibilidad with that modalidad (or AMBOS)
  if (modalidad && (modalidad === 'PRESENCIAL' || modalidad === 'VIRTUAL')) {
    where.disponibilidades = {
      some: {
        activo: true,
        modalidad: { in: [String(modalidad), 'AMBOS'] },
      },
    };
  }

  // Filter by fecha: convert to diaSemana and require availability on that day
  if (fecha) {
    const [year, month, day] = String(fecha).split('-').map(Number);
    const diaSemana = new Date(year, month - 1, day).getDay();
    const dispFilter = { some: { activo: true, diaSemana } };
    if (where.disponibilidades) {
      where.disponibilidades = { some: { activo: true, diaSemana, modalidad: where.disponibilidades.some.modalidad } };
    } else {
      where.disponibilidades = dispFilter;
    }
  }

  // When filtering by real-time availability we pre-require availability for at least one day this week
  if (filterDisponible && !fecha) {
    const hoy = new Date();
    const diasSemana = Array.from({ length: 7 }, (_, i) => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i).getDay());
    const uniqueDias = [...new Set(diasSemana)];
    if (where.disponibilidades) {
      // merge: keep other conditions but also require a diaSemana match
      where.AND = [
        { disponibilidades: where.disponibilidades },
        { disponibilidades: { some: { activo: true, diaSemana: { in: uniqueDias } } } },
      ];
      delete where.disponibilidades;
    } else {
      where.disponibilidades = { some: { activo: true, diaSemana: { in: uniqueDias } } };
    }
  }

  // Ordering
  let orderBy: any = { createdAt: 'desc' };
  if (orderByParam === 'precio_asc')  orderBy = { precioConsulta: 'asc' };
  if (orderByParam === 'precio_desc') orderBy = { precioConsulta: 'desc' };
  if (orderByParam === 'nombre_asc')  orderBy = [{ apellido: 'asc' }, { nombre: 'asc' }];

  // When real-time availability filter is on, we fetch all matches and post-filter.
  // Otherwise use normal DB-level pagination.
  const fetchAll = filterDisponible;
  const skip = fetchAll ? 0 : (pageNum - 1) * limitNum;
  const take = fetchAll ? 500 : limitNum;

  const [profesionales, dbTotal] = await Promise.all([
    prisma.profesional.findMany({
      where,
      include: {
        especialidad: true,
        disponibilidades: { where: { activo: true } },
        _count: { select: { resenas: true } },
      },
      skip,
      take,
      orderBy,
    }),
    fetchAll ? Promise.resolve(0) : prisma.profesional.count({ where }),
  ]);

  // Attach average rating
  const ids = profesionales.map((p) => p.id);
  const ratings = ids.length ? await prisma.resena.groupBy({
    by: ['profesionalId'],
    where: { profesionalId: { in: ids } },
    _avg: { rating: true },
    _count: { rating: true },
  }) : [];
  const ratingMap = new Map(ratings.map((r) => [r.profesionalId, r]));

  let profesionalesConRating = profesionales.map((p) => {
    const r = ratingMap.get(p.id);
    return {
      ...p,
      ratingPromedio: r ? Number(r._avg.rating?.toFixed(1)) : null,
      totalResenas: r ? r._count.rating : 0,
    };
  });

  // ── Real-time slot availability filter ─────────────────────────────────────
  if (filterDisponible) {
    const hoy = new Date();
    // Next 7 calendar days (today inclusive), each with its exact date and diaSemana
    const semana = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
      return { fecha: d, diaSemana: d.getDay() };
    });

    const inicioSemana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 0, 0, 0, 0);
    const finSemana    = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 6, 23, 59, 59, 999);

    // Calculate weekly slot capacity per profesional from disponibilidades
    const capacidadPorProf = new Map<string, number>();
    for (const prof of profesionalesConRating) {
      let capacidad = 0;
      for (const disp of prof.disponibilidades) {
        const diasCoincidentes = semana.filter((s) => s.diaSemana === disp.diaSemana).length;
        if (diasCoincidentes === 0) continue;
        const [hi, mi] = disp.horaInicio.split(':').map(Number);
        const [hf, mf] = disp.horaFin.split(':').map(Number);
        const slotsPerDay = ((hf * 60 + mf) - (hi * 60 + mi)) / 30;
        capacidad += slotsPerDay * diasCoincidentes;
      }
      capacidadPorProf.set(prof.id, capacidad);
    }

    // Batch-fetch booked turno counts for the week (one query)
    const turnosCounts = ids.length ? await prisma.turno.groupBy({
      by: ['profesionalId'],
      where: {
        profesionalId: { in: ids },
        fechaHora: { gte: inicioSemana, lte: finSemana },
        estado: { notIn: ['CANCELADO'] },
      },
      _count: { id: true },
    }) : [];
    const bookedMap = new Map(turnosCounts.map((t) => [t.profesionalId, t._count.id]));

    // Keep only profesionales with at least one free slot this week
    profesionalesConRating = profesionalesConRating.filter((prof) => {
      const capacidad = capacidadPorProf.get(prof.id) ?? 0;
      const booked    = bookedMap.get(prof.id) ?? 0;
      return capacidad > booked;
    });
  }

  // Paginate post-filtered results when fetchAll was used
  const total = fetchAll ? profesionalesConRating.length : dbTotal;
  const paginated = fetchAll
    ? profesionalesConRating.slice((pageNum - 1) * limitNum, pageNum * limitNum)
    : profesionalesConRating;

  res.json(success({
    profesionales: paginated,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [profesional, ratingAgg] = await Promise.all([
    prisma.profesional.findUnique({
      where: { id: req.params.id },
      include: {
        especialidad: true,
        disponibilidades: { where: { activo: true } },
      },
    }),
    prisma.resena.aggregate({
      where: { profesionalId: req.params.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  res.json(success({
    ...profesional,
    ratingPromedio: ratingAgg._avg.rating ? Number(ratingAgg._avg.rating.toFixed(1)) : null,
    totalResenas: ratingAgg._count.rating,
  }));
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
  const fechaStr = String(fecha);
  const [year, month, day] = fechaStr.split('-').map(Number);
  const fechaDate = new Date(year, month - 1, day);
  const diaSemana = fechaDate.getDay();

  const disponibilidad = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.id, diaSemana, activo: true },
  });

  const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);

  const turnosOcupados = await prisma.turno.findMany({
    where: {
      profesionalId: req.params.id,
      fechaHora: { gte: startOfDay, lte: endOfDay },
      estado: { notIn: ['CANCELADO'] },
    },
  });

  const slotsMap = new Map<string, boolean>();

  disponibilidad.forEach((disp) => {
    if (modalidad && disp.modalidad !== modalidad && disp.modalidad !== 'AMBOS') return;

    let [h, m] = disp.horaInicio.split(':').map(Number);
    const [hf, mf] = disp.horaFin.split(':').map(Number);

    while (h < hf || (h === hf && m < mf)) {
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const slotDate = new Date(year, month - 1, day, h, m, 0, 0);

      const ocupado = turnosOcupados.some((t) => t.fechaHora.getTime() === slotDate.getTime());
      if (!slotsMap.has(horaStr)) {
        slotsMap.set(horaStr, !ocupado);
      }

      m += 30;
      if (m >= 60) { h++; m -= 60; }
    }
  });

  const slots = Array.from(slotsMap.entries()).map(([hora, disponible]) => ({ hora, disponible }));

  res.json(success(slots));
}));

export { router as profesionalesRouter };
