export type PreconsultaInput = {
  motivo: string;
  sintomas: string;
  escalaDolor: number;
  escalaAnsiedad: number;
  inicioSintomas?: string | null;
  temperatura?: number | null;
  notasPaciente?: string | null;
  especialidad?: string | null;
};

export type PreconsultaRisk = 'BAJO' | 'MEDIO' | 'ALTO' | 'URGENTE';

export type PreconsultaAnalysis = {
  riesgo: PreconsultaRisk;
  flags: string[];
  resumen: string;
  aiGenerated: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

const RED_FLAG_KEYWORDS = [
  'dolor en el pecho', 'falta de aire', 'dificultad para respirar',
  'sangrado abundante', 'desmayo', 'convuls', 'paralisis',
  'confusion', 'ideacion suicida', 'suicida', 'violencia',
  'no puedo respirar', 'sin aliento',
];

function localAnalyze(input: PreconsultaInput): PreconsultaAnalysis {
  const flags: string[] = [];
  const text = `${input.motivo} ${input.sintomas} ${input.notasPaciente ?? ''}`.toLowerCase();

  if (RED_FLAG_KEYWORDS.some(k => text.includes(k))) flags.push('RED_FLAG_KEYWORD');
  if ((input.temperatura ?? 0) >= 39)                  flags.push('FEVER_HIGH');
  if ((input.temperatura ?? 0) >= 37.8 && (input.temperatura ?? 0) < 39) flags.push('FEVER_MODERATE');
  if (input.escalaDolor >= 8)                           flags.push('PAIN_SEVERE');
  if (input.escalaDolor >= 6 && input.escalaDolor < 8)  flags.push('PAIN_MODERATE');
  if (input.escalaAnsiedad >= 8)                        flags.push('ANXIETY_SEVERE');
  if (input.escalaAnsiedad >= 6 && input.escalaAnsiedad < 8) flags.push('ANXIETY_MODERATE');

  let riesgo: PreconsultaRisk = 'BAJO';
  if (flags.includes('RED_FLAG_KEYWORD') || flags.includes('FEVER_HIGH')) riesgo = 'URGENTE';
  else if (flags.includes('PAIN_SEVERE') || flags.includes('ANXIETY_SEVERE'))   riesgo = 'ALTO';
  else if (flags.length > 0)                                                      riesgo = 'MEDIO';

  const resumen = [
    `Motivo: ${input.motivo}`,
    `Síntomas: ${input.sintomas}`,
    `Dolor ${input.escalaDolor}/10 | Ansiedad ${input.escalaAnsiedad}/10`,
    input.inicioSintomas ? `Inicio: ${input.inicioSintomas}` : null,
    typeof input.temperatura === 'number' ? `Temperatura: ${input.temperatura.toFixed(1)} °C` : null,
    input.notasPaciente ? `Notas: ${input.notasPaciente.slice(0, 120)}` : null,
  ].filter(Boolean).join(' | ');

  return { riesgo, flags, resumen, aiGenerated: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER AI ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

// Free models available on OpenRouter (in order of preference):
// - meta-llama/llama-3.3-70b-instruct:free  → most capable free option
// - meta-llama/llama-3.1-8b-instruct:free   → faster, lighter
// - google/gemma-3-12b-it:free
// Ordered by preference — first available wins
const MODELS = [
  'google/gemma-3-27b-it:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-3-12b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const SYSTEM_PROMPT = `Sos un asistente de triage médico para MediSync, plataforma argentina de salud.
Analizás formularios de preconsulta completados por pacientes antes de una consulta programada.

Tu tarea:
1. Clasificar el nivel de urgencia clínica.
2. Identificar alertas o banderas clínicas relevantes.
3. Generar un resumen clínico conciso y útil para el profesional médico.

Reglas estrictas:
- Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones.
- El campo "riesgo" debe ser exactamente uno de: "BAJO", "MEDIO", "ALTO", "URGENTE".
- "flags" es un array de strings descriptivos en español (máx 6 items, máx 5 palabras c/u). Array vacío si no hay alertas.
- "resumen" es un párrafo de 2-4 oraciones en español rioplatense formal, útil para el profesional.
- No diagnosticás. Triageás.

Niveles de urgencia:
- URGENTE: síntomas potencialmente graves, derivar a guardia o atender de inmediato.
- ALTO: consulta prioritaria, síntomas significativos que requieren atención pronta.
- MEDIO: consulta de rutina con algunos indicadores a vigilar.
- BAJO: sin indicadores de alarma, consulta de rutina.

Formato de respuesta (solo esto, nada más):
{"riesgo":"BAJO","flags":[],"resumen":"..."}`;

async function callModel(apiKey: string, model: string, userMessage: string): Promise<PreconsultaAnalysis> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://medisync.ar',
      'X-Title': 'MediSync Preconsulta',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned empty content');

  const clean = content.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  const riesgo = parsed.riesgo as PreconsultaRisk;
  if (!['BAJO', 'MEDIO', 'ALTO', 'URGENTE'].includes(riesgo)) {
    throw new Error(`Riesgo inválido: ${riesgo}`);
  }

  return {
    riesgo,
    flags:   Array.isArray(parsed.flags)        ? parsed.flags.slice(0, 6)       : [],
    resumen: typeof parsed.resumen === 'string' ? parsed.resumen.slice(0, 1000)  : '',
    aiGenerated: true,
  };
}

async function openRouterAnalyze(input: PreconsultaInput): Promise<PreconsultaAnalysis> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

  const userMessage = `Formulario de preconsulta:
- Especialidad consultada: ${input.especialidad ?? 'no especificada'}
- Motivo de consulta: ${input.motivo}
- Síntomas: ${input.sintomas}
- Escala de dolor (0-10): ${input.escalaDolor}
- Escala de ansiedad (0-10): ${input.escalaAnsiedad}
- Inicio de síntomas: ${input.inicioSintomas ?? 'no especificado'}
- Temperatura: ${input.temperatura != null ? `${input.temperatura} °C` : 'no registrada'}
- Notas del paciente: ${input.notasPaciente ?? 'ninguna'}

Respondé con el JSON estructurado.`;

  // Try each model in order; skip to next on rate-limit (429) or server error (5xx)
  let lastError: Error = new Error('No models available');
  for (const model of MODELS) {
    try {
      const result = await callModel(apiKey, model, userMessage);
      console.log(`[Preconsulta AI] Success with model: ${model}`);
      return result;
    } catch (err: any) {
      lastError = err;
      const is429 = err.message?.includes('429');
      const is5xx = err.message?.match(/OpenRouter 5\d\d/);
      if (is429 || is5xx) {
        console.warn(`[Preconsulta AI] ${model} unavailable (${is429 ? 'rate-limit' : 'server error'}), trying next…`);
        continue;
      }
      // Other errors (auth, bad JSON, etc.) — don't retry
      throw err;
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzePreconsulta(input: PreconsultaInput): Promise<PreconsultaAnalysis> {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await openRouterAnalyze(input);
    } catch (err) {
      console.error('[Preconsulta AI] OpenRouter failed, using local fallback:', err);
    }
  }
  return localAnalyze(input);
}
