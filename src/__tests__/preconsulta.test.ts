import { describe, expect, it } from '@jest/globals';
import { analyzePreconsulta } from '../services/preconsulta.service';

// These tests exercise the LOCAL fallback (no GEMINI_API_KEY in test env).
// The local analyzer is deterministic so results are predictable.

describe('Preconsulta — local fallback analyzer', () => {
  it('detecta riesgo bajo cuando no hay alertas', async () => {
    const result = await analyzePreconsulta({
      motivo: 'Control general',
      sintomas: 'Molestia leve de garganta',
      escalaDolor: 2,
      escalaAnsiedad: 3,
      inicioSintomas: 'ayer',
      temperatura: 36.8,
      notasPaciente: '',
    });

    expect(result.riesgo).toBe('BAJO');
    expect(result.flags).toHaveLength(0);
    expect(result.aiGenerated).toBe(false);
  });

  it('detecta riesgo medio con fiebre moderada', async () => {
    const result = await analyzePreconsulta({
      motivo: 'Fiebre y dolor corporal',
      sintomas: 'Me siento agotado',
      escalaDolor: 4,
      escalaAnsiedad: 4,
      temperatura: 38.2,
    });

    expect(result.riesgo).toBe('MEDIO');
    expect(result.flags).toContain('FEVER_MODERATE');
  });

  it('detecta riesgo alto con dolor severo', async () => {
    const result = await analyzePreconsulta({
      motivo: 'Dolor lumbar intenso',
      sintomas: 'No puedo dormir por el dolor',
      escalaDolor: 9,
      escalaAnsiedad: 4,
    });

    expect(result.riesgo).toBe('ALTO');
    expect(result.flags).toContain('PAIN_SEVERE');
  });

  it('detecta urgente por palabras de bandera roja', async () => {
    const result = await analyzePreconsulta({
      motivo: 'Dolor en el pecho al respirar',
      sintomas: 'Falta de aire desde la madrugada',
      escalaDolor: 6,
      escalaAnsiedad: 8,
      temperatura: 37.2,
    });

    expect(result.riesgo).toBe('URGENTE');
    expect(result.flags).toContain('RED_FLAG_KEYWORD');
  });

  it('detecta urgente por fiebre alta', async () => {
    const result = await analyzePreconsulta({
      motivo: 'Fiebre alta y escalofrios',
      sintomas: 'Me siento muy mal',
      escalaDolor: 5,
      escalaAnsiedad: 5,
      temperatura: 39.4,
    });

    expect(result.riesgo).toBe('URGENTE');
    expect(result.flags).toContain('FEVER_HIGH');
  });
});
