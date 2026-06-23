import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { findProfesionalByUserId } from '../utils/auth-helpers';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { getAvailableSlotsForProfessional } from '../services/slot-availability.service';
import {
  addDaysToClinicDate,
  formatClinicDateKey,
  getClinicDayBoundsFromDateString,
  getClinicWeekdayFromDateString,
} from '../utils/clinic-time';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const {
    especialidad,
    precioMin,
    precioMax,
    modalidad,
    fecha,
    disponibleEstaSemana,
    obraSocial,
    orderBy: orderByParam,
  } = req.query;

  const filterDisponible = disponibleEstaSemana === 'true';
  const { page: pageNum, limit: limitNum } = parsePagination(req);

  const where: any = { activo: true };

  if (especialidad) {
    where.especialidad = { nombre: { contains: String(especialidad), mode: 'insensitive' } };
  }

  if (obraSocial) {
    // PostgreSQL array: has exact match. We normalise to uppercase on both ends.
    where.obrasSociales = { has: String(obraSocial).trim().toUpperCase() };
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
    const diaSemana = getClinicWeekdayFromDateString(String(fecha));
    const dispFilter = { some: { activo: true, diaSemana } };
    if (where.disponibilidades) {
      where.disponibilidades = { some: { activo: true, diaSemana, modalidad: where.disponibilidades.some.modalidad } };
    } else {
      where.disponibilidades = dispFilter;
    }
  }

  // When filtering by real-time availability we pre-require availability for at least one day this week
  if (filterDisponible && !fecha) {
    const hoy = formatClinicDateKey(new Date());
    const diasSemana = Array.from({ length: 7 }, (_, i) => getClinicWeekdayFromDateString(addDaysToClinicDate(hoy, i)));
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
      // Narrowed to the columns the homepage prof-card + capacity calc read;
      // drops ~13 unused scalar columns (matricula, telefono, genero, notif
      // flags, plan, mp/timestamps, …). Matters most under the realtime filter
      // which fetches up to 500 rows.
      select: {
        id: true, nombre: true, apellido: true, fotoUrl: true,
        precioConsulta: true, lugarAtencion: true, obrasSociales: true,
        bio: true, clinicaId: true,
        especialidad: true,
        disponibilidades: {
          where: { activo: true },
          select: { modalidad: true, diaSemana: true, horaInicio: true, horaFin: true },
        },
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
    const hoy = formatClinicDateKey(new Date());
    // Next 7 calendar days (today inclusive), each with its exact date and diaSemana
    const semana = Array.from({ length: 7 }, (_, i) => {
      const fecha = addDaysToClinicDate(hoy, i);
      return { fecha, diaSemana: getClinicWeekdayFromDateString(fecha) };
    });

    const inicioSemana = getClinicDayBoundsFromDateString(hoy).start;
    const finSemana = getClinicDayBoundsFromDateString(addDaysToClinicDate(hoy, 7)).start;

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
        fechaHora: { gte: inicioSemana, lt: finSemana },
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
    pagination: buildPaginationMeta(pageNum, limitNum, total),
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
  const { nombre, apellido, bio, telefono, genero, lugarAtencion, precioConsulta, fotoUrl, obrasSociales, matricula, especialidadId } = req.body;

  const profesionalOwner = await findProfesionalByUserId(req.user!.userId);
  if (profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para editar este perfil');
  }

  if (telefono && !/^[\d\s\-\+\(\)]{8,20}$/.test(telefono)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El teléfono tiene un formato inválido');
  }

  if (genero && !['MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO'].includes(genero)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El género debe ser MASCULINO, FEMENINO, OTRO o NO_ESPECIFICADO');
  }

  if (especialidadId !== undefined) {
    const especialidad = await prisma.especialidad.findUnique({ where: { id: especialidadId } });
    if (!especialidad) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La especialidad seleccionada no existe');
    }
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
      fotoUrl,
      matricula,
      ...(especialidadId !== undefined && { especialidadId }),
      // Normalize to uppercase for consistent filtering
      ...(Array.isArray(obrasSociales) && {
        obrasSociales: obrasSociales.map((o: string) => o.trim().toUpperCase()).filter(Boolean),
      }),
    },
  });

  res.json(success(profesional));
}));

router.post('/:id/disponibilidad', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { diaSemana, horaInicio, horaFin, modalidad, lugarAtencion } = req.body;

  const profesionalOwner = await findProfesionalByUserId(req.user!.userId);
  if (profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para gestionar esta disponibilidad');
  }

  if (!Number.isInteger(diaSemana) || diaSemana < 0 || diaSemana > 6) {
    throw new AppError(400, 'VALIDATION_ERROR', 'diaSemana debe estar entre 0 y 6');
  }

  if (!/^\d{2}:\d{2}$/.test(horaInicio) || !/^\d{2}:\d{2}$/.test(horaFin) || horaInicio >= horaFin) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Rango horario invalido');
  }

  const existingDisp = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.id, diaSemana, activo: true },
  });

  function seSuperponen(h1: string, h2: string, h3: string, h4: string): boolean {
    return h1 < h4 && h2 > h3;
  }

  for (const existente of existingDisp) {
    if (seSuperponen(horaInicio, horaFin, existente.horaInicio, existente.horaFin)) {
      throw new AppError(
        409,
        'HORARIO_SUPERPUESTO',
        `El horario se superpone con un horario existente del día ${['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][diaSemana]} (${existente.horaInicio} - ${existente.horaFin}, ${existente.modalidad})`
      );
    }
  }

  const modalidadNueva = modalidad || 'PRESENCIAL';

  const disponibilidad = await prisma.$transaction(async (tx) => {
    const disp = await tx.disponibilidad.create({
      data: {
        profesionalId: req.params.id,
        diaSemana,
        horaInicio,
        horaFin,
        modalidad: modalidadNueva,
        lugarAtencion: lugarAtencion?.trim() || null,
      },
    });

    await tx.auditoriaDisponibilidad.create({
      data: {
        profesionalId: req.params.id,
        tipoEvento: 'DISPONIBILIDAD_CREADA',
        disponibilidadId: disp.id,
        detalle: { diaSemana, horaInicio, horaFin, modalidad: modalidad || 'PRESENCIAL', lugarAtencion: lugarAtencion?.trim() || null },
      },
    });

    return disp;
  });

  res.status(201).json(success(disponibilidad));
}));

router.get('/:id/disponibilidad', asyncHandler(async (req, res) => {
  const disponibilidades = await prisma.disponibilidad.findMany({
    where: { profesionalId: req.params.id, activo: true },
  });

  res.json(success(disponibilidades));
}));

router.delete('/:id/disponibilidad/:dispId', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesionalOwner = await findProfesionalByUserId(req.user!.userId);
  if (profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para eliminar esta disponibilidad');
  }

  const existing = await prisma.disponibilidad.findUnique({ where: { id: req.params.dispId } });
  if (!existing || existing.profesionalId !== req.params.id) {
    throw new AppError(404, 'NOT_FOUND', 'Disponibilidad no encontrada');
  }

  await prisma.$transaction([
    prisma.disponibilidad.deleteMany({
      where: { id: req.params.dispId, profesionalId: req.params.id },
    }),
    prisma.auditoriaDisponibilidad.create({
      data: {
        profesionalId: req.params.id,
        tipoEvento: 'DISPONIBILIDAD_ELIMINADA',
        disponibilidadId: req.params.dispId,
        detalle: { diaSemana: existing.diaSemana, horaInicio: existing.horaInicio, horaFin: existing.horaFin, modalidad: existing.modalidad },
      },
    }),
  ]);

  res.json(success({ deleted: true }));
}));

router.get('/:id/auditoria', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesionalOwner = await findProfesionalByUserId(req.user!.userId);
  if (profesionalOwner.id !== req.params.id) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos');
  }

  const { page, limit, skip } = parsePagination(req, { limit: 20, maxLimit: 50 });

  const where: any = { profesionalId: req.params.id };
  if (req.query.tipoEvento) where.tipoEvento = req.query.tipoEvento;
  if (req.query.desde) where.creadoAt = { ...where.creadoAt, gte: new Date(String(req.query.desde)) };
  if (req.query.hasta) where.creadoAt = { ...where.creadoAt, lte: new Date(String(req.query.hasta)) };

  const [items, total] = await Promise.all([
    prisma.auditoriaDisponibilidad.findMany({ where, orderBy: { creadoAt: 'desc' }, skip, take: limit }),
    prisma.auditoriaDisponibilidad.count({ where }),
  ]);

  res.json(success({ data: items, pagination: buildPaginationMeta(page, limit, total) }));
}));

router.get('/:id/slots-disponibles', asyncHandler(async (req, res) => {
  const { fecha, modalidad } = req.query;
  if (!fecha || typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fecha es requerida y debe tener formato YYYY-MM-DD');
  }
  const slots = await getAvailableSlotsForProfessional({
    profesionalId: req.params.id,
    fecha,
    modalidad: modalidad ? String(modalidad) : undefined,
  });

  res.json(success(slots));
}));

export { router as profesionalesRouter };
