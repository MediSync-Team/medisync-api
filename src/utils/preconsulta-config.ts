import { AppError } from './response';

/**
 * Per-professional pre-consultation questionnaire configuration.
 *
 * `motivo` and `sintomas` are always shown and required (they feed the AI
 * triage in preconsulta.service.ts) so they are NOT part of this config.
 * Everything else is up to the professional: they can toggle the built-in
 * default fields on/off (and mark them required) and add their own custom
 * questions — a psychologist and a cardiologist rarely need the same intake.
 *
 * Stored as JSON on `Profesional.preconsultaConfig`. Patient answers to the
 * custom questions are stored (keyed by question id) on
 * `Turno.preconsultaRespuestas`; the default fields keep their columns.
 */

export type PreconsultaFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'scale'
  | 'boolean'
  | 'select';

/** Toggleable built-in fields (motivo + sintomas are always-on core, excluded). */
export const PRECONSULTA_DEFAULT_FIELDS = [
  'escalaDolor',
  'escalaAnsiedad',
  'inicioSintomas',
  'temperatura',
  'notasPaciente',
] as const;

export type PreconsultaDefaultField = (typeof PRECONSULTA_DEFAULT_FIELDS)[number];

export interface PreconsultaDefaultToggle {
  enabled: boolean;
  required: boolean;
}

export interface PreconsultaCustomQuestion {
  id: string;
  label: string;
  type: PreconsultaFieldType;
  required: boolean;
  options?: string[]; // only for type === 'select'
}

export interface PreconsultaConfig {
  defaults: Record<PreconsultaDefaultField, PreconsultaDefaultToggle>;
  custom: PreconsultaCustomQuestion[];
}

export type PreconsultaRespuestas = Record<string, string | number | boolean>;

const CUSTOM_TYPES: PreconsultaFieldType[] = ['text', 'textarea', 'number', 'scale', 'boolean', 'select'];
const MAX_CUSTOM_QUESTIONS = 20;
const MAX_LABEL_LEN = 120;
const MAX_OPTIONS = 12;
const MAX_OPTION_LEN = 60;

function genId(): string {
  return 'q_' + Math.random().toString(36).slice(2, 10);
}

/** The out-of-the-box config: mirrors the historical fixed form (all defaults on, none required). */
export function defaultPreconsultaConfig(): PreconsultaConfig {
  return {
    defaults: {
      escalaDolor: { enabled: true, required: false },
      escalaAnsiedad: { enabled: true, required: false },
      inicioSintomas: { enabled: true, required: false },
      temperatura: { enabled: true, required: false },
      notasPaciente: { enabled: true, required: false },
    },
    custom: [],
  };
}

function applyDefaults(config: PreconsultaConfig, defaultsRaw: Record<string, unknown>): void {
  for (const field of PRECONSULTA_DEFAULT_FIELDS) {
    const t = defaultsRaw[field] as Record<string, unknown> | undefined;
    if (t && typeof t === 'object') {
      config.defaults[field] = {
        enabled: t.enabled !== false, // default on
        required: t.required === true,
      };
    }
  }
}

/** Coerce whatever is stored in the DB (possibly null / partial / legacy) into a valid config. */
export function normalizePreconsultaConfig(raw: unknown): PreconsultaConfig {
  const config = defaultPreconsultaConfig();
  if (!raw || typeof raw !== 'object') return config;
  const obj = raw as Record<string, unknown>;

  applyDefaults(config, (obj.defaults ?? {}) as Record<string, unknown>);

  const customRaw = Array.isArray(obj.custom) ? obj.custom : [];
  config.custom = customRaw
    .map(normalizeQuestion)
    .filter((q): q is PreconsultaCustomQuestion => q !== null)
    .slice(0, MAX_CUSTOM_QUESTIONS);

  return config;
}

function normalizeQuestion(raw: unknown): PreconsultaCustomQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const label = typeof q.label === 'string' ? q.label.trim() : '';
  if (!label) return null;
  const type = CUSTOM_TYPES.includes(q.type as PreconsultaFieldType) ? (q.type as PreconsultaFieldType) : 'text';
  const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : genId();
  const question: PreconsultaCustomQuestion = {
    id,
    label: label.slice(0, MAX_LABEL_LEN),
    type,
    required: q.required === true,
  };
  if (type === 'select') {
    question.options = Array.isArray(q.options)
      ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, MAX_OPTIONS).map((o) => o.slice(0, MAX_OPTION_LEN))
      : [];
  }
  return question;
}

/**
 * Validate a config submitted by a professional. Throws AppError(400) on hard
 * errors; otherwise returns the cleaned config ready to persist.
 */
export function validatePreconsultaConfig(raw: unknown): PreconsultaConfig {
  if (!raw || typeof raw !== 'object') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Configuración de preconsulta inválida');
  }
  const obj = raw as Record<string, unknown>;
  const config = defaultPreconsultaConfig();

  applyDefaults(config, (obj.defaults ?? {}) as Record<string, unknown>);

  const customRaw = Array.isArray(obj.custom) ? obj.custom : [];
  if (customRaw.length > MAX_CUSTOM_QUESTIONS) {
    throw new AppError(400, 'VALIDATION_ERROR', `Máximo ${MAX_CUSTOM_QUESTIONS} preguntas personalizadas`);
  }

  const seenIds = new Set<string>();
  config.custom = customRaw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', `Pregunta ${idx + 1} inválida`);
    }
    const q = entry as Record<string, unknown>;
    const label = typeof q.label === 'string' ? q.label.trim() : '';
    if (!label) throw new AppError(400, 'VALIDATION_ERROR', `La pregunta ${idx + 1} necesita un texto`);
    if (label.length > MAX_LABEL_LEN) throw new AppError(400, 'VALIDATION_ERROR', `La pregunta ${idx + 1} es demasiado larga (máx ${MAX_LABEL_LEN})`);
    const type = CUSTOM_TYPES.includes(q.type as PreconsultaFieldType) ? (q.type as PreconsultaFieldType) : null;
    if (!type) throw new AppError(400, 'VALIDATION_ERROR', `Tipo inválido en la pregunta ${idx + 1}`);

    let id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : genId();
    if (seenIds.has(id)) id = genId();
    seenIds.add(id);

    const question: PreconsultaCustomQuestion = { id, label: label.slice(0, MAX_LABEL_LEN), type, required: q.required === true };
    if (type === 'select') {
      const options = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim()).filter(Boolean).map((o) => o.slice(0, MAX_OPTION_LEN)).slice(0, MAX_OPTIONS)
        : [];
      if (options.length < 2) throw new AppError(400, 'VALIDATION_ERROR', `La pregunta "${label}" necesita al menos 2 opciones`);
      question.options = options;
    }
    return question;
  });

  return config;
}

/**
 * Validate a patient's answers to the professional's custom questions against
 * the (already normalized) config. Throws AppError(400) when a required answer
 * is missing or a value is the wrong shape; returns the cleaned answers map.
 * Only custom questions are handled here — the built-in default fields are
 * validated separately in clinical.service.ts against their config toggles.
 */
export function validateRespuestas(config: PreconsultaConfig, raw: unknown): PreconsultaRespuestas {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: PreconsultaRespuestas = {};

  for (const q of config.custom) {
    const val = input[q.id];
    const missing = val === undefined || val === null || val === '';

    if (missing) {
      if (q.required && q.type !== 'boolean') {
        throw new AppError(400, 'VALIDATION_ERROR', `Falta responder: ${q.label}`);
      }
      if (q.type === 'boolean') out[q.id] = false; // absent checkbox → false
      continue;
    }

    switch (q.type) {
      case 'text':
      case 'textarea': {
        const s = String(val).trim();
        if (!s) {
          if (q.required) throw new AppError(400, 'VALIDATION_ERROR', `Falta responder: ${q.label}`);
          break;
        }
        out[q.id] = s.slice(0, q.type === 'textarea' ? 2000 : 400);
        break;
      }
      case 'number': {
        const n = Number(val);
        if (!Number.isFinite(n)) throw new AppError(400, 'VALIDATION_ERROR', `"${q.label}" debe ser un número`);
        out[q.id] = n;
        break;
      }
      case 'scale': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0 || n > 10) {
          throw new AppError(400, 'VALIDATION_ERROR', `"${q.label}" debe estar entre 0 y 10`);
        }
        out[q.id] = n;
        break;
      }
      case 'boolean': {
        out[q.id] = val === true || val === 'true' || val === 'si' || val === 'sí' || val === 1;
        break;
      }
      case 'select': {
        const s = String(val);
        if (!q.options || !q.options.includes(s)) {
          throw new AppError(400, 'VALIDATION_ERROR', `Opción inválida en "${q.label}"`);
        }
        out[q.id] = s;
        break;
      }
    }
  }

  return out;
}
