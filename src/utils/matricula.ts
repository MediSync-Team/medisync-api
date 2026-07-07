/**
 * Argentine health-professional license (matrícula) format validation.
 *
 * There is no open public API to verify a matrícula against the national
 * registry (REFEPS/SISA exposes only the "Buscador Nacional" web UI and
 * credentialed institutional web services), so we validate the format instead.
 *
 * Accepted shapes:
 *   - a plain number: `123456`
 *   - short letter prefix + number: `MN 123456`, `MP 12345`, `LP 54321`, `M.P. 12345`
 *   - an optional short numeric suffix: `12345/1`, `12345-2`
 */
export const MATRICULA_MAX_LENGTH = 20;

export const MATRICULA_REGEX = /^([A-Za-z]\.?\s?){0,4}\d{2,7}([-/]\d{1,4})?$/;

export function isValidMatricula(value: string): boolean {
  const v = value.trim();
  return v.length >= 2 && v.length <= MATRICULA_MAX_LENGTH && MATRICULA_REGEX.test(v);
}
