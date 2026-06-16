import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { analyzePreconsulta } from '../preconsulta.service';
import { formatClinicDateEs, formatClinicTimeEs, formatClinicDateTimeEs } from '../../utils/clinic-time';
import { assertTurnoAccess, assertPreconsultaEditable, notifyTurnoUser } from './turno-helpers';

export interface GuardarPreconsultaInput {
  motivo?: unknown;
  sintomas?: unknown;
  escalaDolor?: unknown;
  escalaAnsiedad?: unknown;
  inicioSintomas?: unknown;
  temperatura?: unknown;
  notasPaciente?: unknown;
}

/**
 * Validate, AI-analyze and persist a patient's pre-consultation questionnaire.
 * Returns the shaped preconsulta payload including the `aiGenerated` flag.
 */
export async function guardarPreconsulta(turnoId: string, userId: string, body: GuardarPreconsultaInput) {
  const { motivo, sintomas, escalaDolor, escalaAnsiedad, inicioSintomas, temperatura, notasPaciente } = body;

  const { turno, isPacienteOwner } = await assertTurnoAccess(turnoId, userId);

  if (!isPacienteOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Solo el paciente del turno puede completar la preconsulta');
  }

  assertPreconsultaEditable(turno);

  if (typeof motivo !== 'string' || motivo.trim().length < 5 || motivo.trim().length > 400) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El motivo debe tener entre 5 y 400 caracteres');
  }

  if (typeof sintomas !== 'string' || sintomas.trim().length < 5 || sintomas.trim().length > 1200) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Los sintomas deben tener entre 5 y 1200 caracteres');
  }

  if (!Number.isInteger(escalaDolor) || (escalaDolor as number) < 0 || (escalaDolor as number) > 10) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La escala de dolor debe estar entre 0 y 10');
  }

  if (!Number.isInteger(escalaAnsiedad) || (escalaAnsiedad as number) < 0 || (escalaAnsiedad as number) > 10) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La escala de ansiedad debe estar entre 0 y 10');
  }

  const inicioNormalizado = typeof inicioSintomas === 'string' && inicioSintomas.trim().length > 0
    ? inicioSintomas.trim().slice(0, 80)
    : null;

  const notasNormalizadas = typeof notasPaciente === 'string' && notasPaciente.trim().length > 0
    ? notasPaciente.trim().slice(0, 2000)
    : null;

  let temperaturaNormalizada: number | null = null;
  if (temperatura !== undefined && temperatura !== null && temperatura !== '') {
    if (typeof temperatura !== 'number' || Number.isNaN(temperatura) || temperatura < 34 || temperatura > 43) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La temperatura debe estar entre 34 y 43');
    }
    temperaturaNormalizada = Math.round(temperatura * 10) / 10;
  }

  // Load especialidad name for AI context
  const profConEspecialidad = await prisma.profesional.findUnique({
    where: { id: turno.profesionalId },
    include: { especialidad: { select: { nombre: true } } },
  });

  const analysis = await analyzePreconsulta({
    motivo: motivo.trim(),
    sintomas: sintomas.trim(),
    escalaDolor: escalaDolor as number,
    escalaAnsiedad: escalaAnsiedad as number,
    inicioSintomas: inicioNormalizado,
    temperatura: temperaturaNormalizada,
    notasPaciente: notasNormalizadas,
    especialidad: profConEspecialidad?.especialidad?.nombre ?? null,
  });

  const updated = await prisma.turno.update({
    where: { id: turno.id },
    data: {
      preconsultaMotivo: motivo.trim(),
      preconsultaSintomas: sintomas.trim(),
      preconsultaEscalaDolor: escalaDolor as number,
      preconsultaEscalaAnsiedad: escalaAnsiedad as number,
      preconsultaInicioSintomas: inicioNormalizado,
      preconsultaTemperatura: temperaturaNormalizada,
      preconsultaNotasPaciente: notasNormalizadas,
      preconsultaRiesgo: analysis.riesgo,
      preconsultaFlags: analysis.flags,
      preconsultaResumen: analysis.resumen,
      preconsultaCompletadaAt: new Date(),
    },
    select: {
      id: true,
      preconsultaMotivo: true,
      preconsultaSintomas: true,
      preconsultaEscalaDolor: true,
      preconsultaEscalaAnsiedad: true,
      preconsultaInicioSintomas: true,
      preconsultaTemperatura: true,
      preconsultaNotasPaciente: true,
      preconsultaRiesgo: true,
      preconsultaFlags: true,
      preconsultaResumen: true,
      preconsultaCompletadaAt: true,
    },
  });

  return {
    motivo: updated.preconsultaMotivo,
    sintomas: updated.preconsultaSintomas,
    escalaDolor: updated.preconsultaEscalaDolor,
    escalaAnsiedad: updated.preconsultaEscalaAnsiedad,
    inicioSintomas: updated.preconsultaInicioSintomas,
    temperatura: updated.preconsultaTemperatura ? Number(updated.preconsultaTemperatura) : null,
    notasPaciente: updated.preconsultaNotasPaciente,
    riesgo: updated.preconsultaRiesgo,
    flags: updated.preconsultaFlags,
    resumen: updated.preconsultaResumen,
    completadaAt: updated.preconsultaCompletadaAt,
    aiGenerated: analysis.aiGenerated,
  };
}

/**
 * Upsert a professional's clinical evolution note for a turno.
 */
export async function guardarEvolucion(turnoId: string, userId: string, contenido: unknown) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { profesional: { select: { usuarioId: true } } },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (turno.profesional.usuarioId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para actualizar esta evolucion');
  }

  if (!contenido || String(contenido).trim().length < 5) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El contenido debe tener al menos 5 caracteres');
  }

  return prisma.evolucion.upsert({
    where: { turnoId },
    update: { contenido: contenido as string },
    create: { turnoId, contenido: contenido as string },
  });
}

export interface GuardarRecetaInput {
  diagnostico?: unknown;
  planTratamiento?: unknown;
  medicamentos?: unknown;
  indicaciones?: unknown;
  estudiosSolicitados?: unknown;
  proximoControl?: unknown;
  advertencias?: unknown;
  observaciones?: unknown;
}

/**
 * Upsert a professional's prescription/indications for a turno, build the
 * shareable plain-text version and notify the paciente. Returns `{ receta,
 * shareText }`.
 */
export async function guardarReceta(turnoId: string, userId: string, body: GuardarRecetaInput) {
  const { diagnostico, planTratamiento, medicamentos, indicaciones, estudiosSolicitados, proximoControl, advertencias, observaciones } = body;

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      profesional: { select: { usuarioId: true, nombre: true, apellido: true, matricula: true, especialidad: { select: { nombre: true } } } },
      paciente: { select: { nombre: true, apellido: true, email: true } },
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (turno.profesional.usuarioId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para emitir indicaciones en este turno');
  }

  if (!['CONFIRMADO', 'COMPLETADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede emitir receta/indicaciones en turnos confirmados o completados');
  }

  if (typeof diagnostico !== 'string' || diagnostico.trim().length < 5 || diagnostico.trim().length > 2000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El diagnostico debe tener entre 5 y 2000 caracteres');
  }

  if (typeof indicaciones !== 'string' || indicaciones.trim().length < 5 || indicaciones.trim().length > 4000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Las indicaciones deben tener entre 5 y 4000 caracteres');
  }

  const normalize = (value: unknown, max: number) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
  };

  const recetaData = {
    diagnostico: diagnostico.trim(),
    planTratamiento: normalize(planTratamiento, 4000),
    medicamentos: normalize(medicamentos, 4000),
    indicaciones: indicaciones.trim(),
    estudiosSolicitados: normalize(estudiosSolicitados, 4000),
    proximoControl: normalize(proximoControl, 200),
    advertencias: normalize(advertencias, 2000),
    observaciones: normalize(observaciones, 3000),
    emitidaAt: new Date(),
  };

  const receta = await prisma.recetaIndicacion.upsert({
    where: { turnoId },
    update: recetaData,
    create: { turnoId, ...recetaData },
  });

  const recetaTexto = [
    `MediSync - Receta e indicaciones`,
    `Profesional: Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
    `Especialidad: ${turno.profesional.especialidad.nombre}`,
    turno.profesional.matricula ? `Matricula: ${turno.profesional.matricula}` : null,
    `Paciente: ${turno.paciente ? `${turno.paciente.nombre} ${turno.paciente.apellido}` : 'Sin cuenta'}`,
    `Fecha atencion: ${formatClinicDateEs(turno.fechaHora)} ${formatClinicTimeEs(turno.fechaHora)}`,
    '',
    `Diagnostico:`,
    receta.diagnostico,
    '',
    receta.planTratamiento ? `Plan de tratamiento:\n${receta.planTratamiento}\n` : null,
    receta.medicamentos ? `Medicamentos:\n${receta.medicamentos}\n` : null,
    `Indicaciones:`,
    receta.indicaciones,
    '',
    receta.estudiosSolicitados ? `Estudios solicitados:\n${receta.estudiosSolicitados}\n` : null,
    receta.proximoControl ? `Proximo control: ${receta.proximoControl}` : null,
    receta.advertencias ? `Advertencias: ${receta.advertencias}` : null,
    receta.observaciones ? `Observaciones: ${receta.observaciones}` : null,
    '',
    `Emitida: ${formatClinicDateTimeEs(receta.emitidaAt)}`,
  ].filter(Boolean).join('\n');

  // Notificar al paciente que la receta fue emitida
  if (turno.paciente?.email) {
    const pacienteCompleto = await prisma.paciente.findFirst({
      where: { email: turno.paciente.email },
      select: { usuarioId: true, notifEmail: true, notifWhatsapp: true, telefono: true },
    });
    if (pacienteCompleto) {
      await notifyTurnoUser(
        { notifEmail: pacienteCompleto.notifEmail, notifWhatsapp: pacienteCompleto.notifWhatsapp },
        {
          event: 'RECETA_EMITIDA',
          title: 'Tu receta fue emitida',
          message: `${turno.profesional.nombre} ${turno.profesional.apellido} emitió tu receta/indicaciones de la consulta del ${formatClinicDateEs(turno.fechaHora)}.`,
          userEmail: turno.paciente.email,
          userPhone: pacienteCompleto.telefono ?? undefined,
          meta: {
            turnoId: turno.id,
            fechaHora: turno.fechaHora.toISOString(),
            profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
            especialidad: turno.profesional.especialidad.nombre,
          },
        },
        {
          usuarioId: pacienteCompleto.usuarioId,
          tipo: 'RECETA_EMITIDA',
          titulo: 'Receta emitida',
          cuerpo: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido} emitió tu receta de la consulta del ${formatClinicDateEs(turno.fechaHora)}.`,
          link: '/dashboard/paciente',
        }
      );
    }
  }

  return { receta, shareText: recetaTexto };
}
