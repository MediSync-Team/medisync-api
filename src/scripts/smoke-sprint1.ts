import 'dotenv/config';

type LoginResponse = {
  success: boolean;
  data?: {
    token: string;
    user: {
      id: string;
      rol: 'PACIENTE' | 'PROFESIONAL';
      paciente?: { id: string };
      profesional?: { id: string };
    };
  };
  error?: { message?: string };
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type Profesional = {
  id: string;
  nombre: string;
  apellido: string;
  precioConsulta: number | string;
  disponibilidades?: Array<{
    diaSemana: number;
    horaInicio: string;
    horaFin: string;
    modalidad: 'PRESENCIAL' | 'VIRTUAL' | 'AMBOS';
  }>;
};

type Turno = {
  id: string;
  profesionalId: string;
  pacienteId?: string | null;
  fechaHora: string;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
  estado: string;
};

const API_BASE = process.env.SMOKE_API_BASE_URL || process.env.BACKEND_URL || 'http://localhost:4000/api';

const PACIENTE_EMAIL = process.env.SMOKE_PACIENTE_EMAIL;
const PACIENTE_PASSWORD = process.env.SMOKE_PACIENTE_PASSWORD;

function assertEnv() {
  if (!PACIENTE_EMAIL || !PACIENTE_PASSWORD) {
    throw new Error('Faltan SMOKE_PACIENTE_EMAIL o SMOKE_PACIENTE_PASSWORD');
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  if (init.headers && typeof init.headers === 'object') {
    Object.assign(headers, init.headers as Record<string, string>);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  const json = (await res.json()) as ApiEnvelope<T>;
  return json;
}

async function loginPaciente() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: PACIENTE_EMAIL,
      password: PACIENTE_PASSWORD,
    }),
  });

  const data = (await res.json()) as LoginResponse;

  if (!data.success || !data.data?.token || data.data.user.rol !== 'PACIENTE') {
    throw new Error(`Login paciente fallo: ${data.error?.message || 'respuesta invalida'}`);
  }

  return data.data.token;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function setTime(date: Date, hour: number, minute: number) {
  const copy = new Date(date);
  copy.setHours(hour, minute, 0, 0);
  return copy;
}

function parseHourMinute(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':').map(Number);
  return { hour: h, minute: m };
}

async function findReservableSlot(prof: Profesional): Promise<{ fechaHora: Date; modalidad: 'PRESENCIAL' | 'VIRTUAL' } | null> {
  const disponibilidades = prof.disponibilidades || [];
  if (!disponibilidades.length) return null;

  for (let dayOffset = 1; dayOffset <= 30; dayOffset++) {
    const targetDate = addDays(new Date(), dayOffset);
    const day = targetDate.getDay();

    const disponibilidad = disponibilidades.find((d) => d.diaSemana === day);
    if (!disponibilidad) continue;

    const { hour, minute } = parseHourMinute(disponibilidad.horaInicio);
    const slot = setTime(targetDate, hour, minute);

    if (slot <= new Date()) continue;

    const modalidad: 'PRESENCIAL' | 'VIRTUAL' =
      disponibilidad.modalidad === 'VIRTUAL' ? 'VIRTUAL' : 'PRESENCIAL';

    return { fechaHora: slot, modalidad };
  }

  return null;
}

async function main() {
  assertEnv();

  console.log('--- Smoke Sprint 1 ---');
  console.log(`API: ${API_BASE}`);

  const token = await loginPaciente();
  console.log('1) Login paciente: OK');

  const profesionalesRes = await request<{ profesionales: Profesional[] }>('/profesionales?limit=20', {}, token);
  if (!profesionalesRes.success || !profesionalesRes.data?.profesionales?.length) {
    throw new Error('No se encontraron profesionales para prueba');
  }

  const profesional = profesionalesRes.data.profesionales.find((p) => (p.disponibilidades || []).length > 0);
  if (!profesional) {
    throw new Error('No hay profesionales con disponibilidad activa para smoke test');
  }

  const slotInfo = await findReservableSlot(profesional);
  if (!slotInfo) {
    throw new Error('No se encontro slot reservable en los proximos 30 dias');
  }

  const reservaRes = await request<{ turno: Turno; linkPago: string | null }>(
    '/turnos/reservar',
    {
      method: 'POST',
      body: JSON.stringify({
        profesionalId: profesional.id,
        fechaHora: slotInfo.fechaHora.toISOString(),
        modalidad: slotInfo.modalidad,
      }),
    },
    token
  );

  if (!reservaRes.success || !reservaRes.data?.turno?.id) {
    throw new Error(`Reserva fallo: ${reservaRes.error?.message || 'sin detalle'}`);
  }

  const turnoId = reservaRes.data.turno.id;
  console.log(`2) Reserva turno (${turnoId}): OK`);

  const nuevaFecha = addDays(slotInfo.fechaHora, 1);
  const reprogramarRes = await request<Turno>(
    `/turnos/${turnoId}/reprogramar`,
    {
      method: 'POST',
      body: JSON.stringify({
        fechaHora: nuevaFecha.toISOString(),
        modalidad: slotInfo.modalidad,
      }),
    },
    token
  );

  if (!reprogramarRes.success || !reprogramarRes.data?.id) {
    throw new Error(`Reprogramacion fallo: ${reprogramarRes.error?.message || 'sin detalle'}`);
  }

  console.log('3) Reprogramacion: OK');

  const politicaRes = await request<{ horasMinimas: number }>('/turnos/politica-cancelacion', {}, token);
  if (!politicaRes.success || typeof politicaRes.data?.horasMinimas !== 'number') {
    throw new Error('No se pudo validar politica de cancelacion');
  }

  console.log(`4) Politica cancelacion (${politicaRes.data.horasMinimas}h): OK`);

  const pagoEstadoRes = await request<{ estado: string | null; necesitaPago?: boolean; initPoint?: string | null }>(
    `/pagos/estado/${turnoId}`,
    {},
    token
  );

  if (!pagoEstadoRes.success) {
    throw new Error(`Consulta estado pago fallo: ${pagoEstadoRes.error?.message || 'sin detalle'}`);
  }

  console.log(`5) Estado pago endpoint: OK (estado=${pagoEstadoRes.data?.estado || 'null'})`);

  const cancelarRes = await request<Turno>(
    `/turnos/${turnoId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ estado: 'CANCELADO' }),
    },
    token
  );

  if (!cancelarRes.success) {
    throw new Error(`Cancelacion fallo: ${cancelarRes.error?.message || 'sin detalle'}`);
  }

  console.log('6) Cancelacion: OK');
  console.log('Smoke Sprint 1 finalizado correctamente');
}

main().catch((err) => {
  console.error('Smoke Sprint 1 fallo:', err instanceof Error ? err.message : err);
  process.exit(1);
});
