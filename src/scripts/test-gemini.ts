/**
 * Script de prueba para la integración con Gemini AI.
 * Ejecutar con: npx ts-node src/scripts/test-gemini.ts
 */
import 'dotenv/config';
import { analyzePreconsulta } from '../services/preconsulta.service';

const CASOS = [
  {
    nombre: '✅ Caso BAJO (control rutinario)',
    input: {
      motivo: 'Control anual de rutina',
      sintomas: 'Me siento bien, solo vengo por el chequeo anual',
      escalaDolor: 1,
      escalaAnsiedad: 2,
      especialidad: 'Clínica Médica',
    },
  },
  {
    nombre: '⚠️  Caso MEDIO (síntomas moderados)',
    input: {
      motivo: 'Dolor de cabeza frecuente',
      sintomas: 'Tengo migraña casi todos los días desde hace una semana, con sensibilidad a la luz',
      escalaDolor: 6,
      escalaAnsiedad: 5,
      temperatura: 37.5,
      especialidad: 'Neurología',
    },
  },
  {
    nombre: '🔴 Caso URGENTE (bandera roja)',
    input: {
      motivo: 'Dolor en el pecho y falta de aire',
      sintomas: 'Desde hace 2 horas tengo dolor en el pecho que se irradia al brazo izquierdo, dificultad para respirar y sudoración',
      escalaDolor: 9,
      escalaAnsiedad: 9,
      temperatura: 38.1,
      notasPaciente: 'Tengo antecedentes de hipertensión',
      especialidad: 'Cardiología',
    },
  },
];

async function main() {
  console.log('\n=== Test Gemini AI — Preconsulta Inteligente ===\n');
  const key = process.env.OPENROUTER_API_KEY;
  console.log(`OPENROUTER_API_KEY: ${key ? `configurada (${key.slice(0, 16)}...)` : '❌ NO CONFIGURADA — usará fallback local'}\n`);

  for (const caso of CASOS) {
    console.log(`─── ${caso.nombre} ───`);
    try {
      const resultado = await analyzePreconsulta(caso.input as any);
      console.log(`  Riesgo:       ${resultado.riesgo}`);
      console.log(`  AI generado:  ${resultado.aiGenerated ? '✅ Gemini' : '⚠️  Fallback local'}`);
      console.log(`  Flags:        ${resultado.flags.length > 0 ? resultado.flags.join(', ') : '(ninguna)'}`);
      console.log(`  Resumen:      ${resultado.resumen}`);
    } catch (err: any) {
      console.log(`  ❌ ERROR: ${err.message}`);
    }
    console.log();
  }
}

main().catch(console.error);
