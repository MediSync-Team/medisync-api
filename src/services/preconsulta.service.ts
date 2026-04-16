export type PreconsultaInput = {
  motivo: string;
  sintomas: string;
  escalaDolor: number;
  escalaAnsiedad: number;
  inicioSintomas?: string | null;
  temperatura?: number | null;
  notasPaciente?: string | null;
};

export type PreconsultaRisk = 'BAJO' | 'MEDIO' | 'ALTO' | 'URGENTE';

export type PreconsultaAnalysis = {
  riesgo: PreconsultaRisk;
  flags: string[];
  resumen: string;
};

const RED_FLAG_KEYWORDS = [
  'dolor en el pecho',
  'falta de aire',
  'dificultad para respirar',
  'sangrado abundante',
  'desmayo',
  'convuls',
  'paralisis',
  'confusion',
  'ideacion suicida',
  'suicida',
  'violencia',
];

export function analyzePreconsulta(input: PreconsultaInput): PreconsultaAnalysis {
  const flags: string[] = [];
  const normalizedText = `${input.motivo} ${input.sintomas} ${input.notasPaciente || ''}`.toLowerCase();

  const hasRedFlagKeyword = RED_FLAG_KEYWORDS.some((keyword) => normalizedText.includes(keyword));

  if (hasRedFlagKeyword) flags.push('RED_FLAG_KEYWORD');
  if ((input.temperatura ?? 0) >= 39) flags.push('FEVER_HIGH');
  if ((input.temperatura ?? 0) >= 37.8 && (input.temperatura ?? 0) < 39) flags.push('FEVER_MODERATE');
  if (input.escalaDolor >= 8) flags.push('PAIN_SEVERE');
  if (input.escalaDolor >= 6 && input.escalaDolor < 8) flags.push('PAIN_MODERATE');
  if (input.escalaAnsiedad >= 8) flags.push('ANXIETY_SEVERE');
  if (input.escalaAnsiedad >= 6 && input.escalaAnsiedad < 8) flags.push('ANXIETY_MODERATE');

  let riesgo: PreconsultaRisk = 'BAJO';

  if (flags.includes('RED_FLAG_KEYWORD') || flags.includes('FEVER_HIGH')) {
    riesgo = 'URGENTE';
  } else if (flags.includes('PAIN_SEVERE') || flags.includes('ANXIETY_SEVERE')) {
    riesgo = 'ALTO';
  } else if (flags.length > 0) {
    riesgo = 'MEDIO';
  }

  const resumen = [
    `Motivo: ${input.motivo}`,
    `Sintomas: ${input.sintomas}`,
    `Dolor ${input.escalaDolor}/10`,
    `Ansiedad ${input.escalaAnsiedad}/10`,
    input.inicioSintomas ? `Inicio: ${input.inicioSintomas}` : null,
    typeof input.temperatura === 'number' ? `Temperatura: ${input.temperatura.toFixed(1)} C` : null,
  ].filter(Boolean).join(' | ');

  return { riesgo, flags, resumen };
}
