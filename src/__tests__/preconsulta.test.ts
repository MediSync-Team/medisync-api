import { describe, expect, it } from '@jest/globals';
import { analyzePreconsulta } from '../services/preconsulta.service';

describe('Preconsulta inteligente', () => {
  it('detecta riesgo bajo cuando no hay alertas', () => {
    const result = analyzePreconsulta({
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
    expect(result.resumen).toContain('Motivo: Control general');
  });

  it('detecta riesgo medio con fiebre moderada', () => {
    const result = analyzePreconsulta({
      motivo: 'Fiebre y dolor corporal',
      sintomas: 'Me siento agotado',
      escalaDolor: 4,
      escalaAnsiedad: 4,
      temperatura: 38.2,
    });

    expect(result.riesgo).toBe('MEDIO');
    expect(result.flags).toContain('FEVER_MODERATE');
  });

  it('detecta riesgo alto con dolor severo', () => {
    const result = analyzePreconsulta({
      motivo: 'Dolor lumbar intenso',
      sintomas: 'No puedo dormir por el dolor',
      escalaDolor: 9,
      escalaAnsiedad: 4,
    });

    expect(result.riesgo).toBe('ALTO');
    expect(result.flags).toContain('PAIN_SEVERE');
  });

  it('detecta urgente por palabras de bandera roja', () => {
    const result = analyzePreconsulta({
      motivo: 'Dolor en el pecho al respirar',
      sintomas: 'Falta de aire desde la madrugada',
      escalaDolor: 6,
      escalaAnsiedad: 8,
      temperatura: 37.2,
    });

    expect(result.riesgo).toBe('URGENTE');
    expect(result.flags).toContain('RED_FLAG_KEYWORD');
  });

  it('detecta urgente por fiebre alta', () => {
    const result = analyzePreconsulta({
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
