import { Result } from 'express-validator';
import { AppError } from './response';

/**
 * Throw an `AppError(400, 'VALIDATION_ERROR', <first message>)` if the
 * express-validator result contains any errors.
 *
 * Use this as a single-line replacement for the repetitive pattern:
 * ```
 * const errors = validationResult(req);
 * if (!errors.isEmpty()) {
 *   throw new AppError(400, 'VALIDATION_ERROR', errors.array()[0].msg);
 * }
 * ```
 *
 * Note: Only the **first** validation error message is included in the
 * response. If you need all errors, use `validationResult(req)` directly.
 */
export function validateRequest(result: Result): void {
  if (!result.isEmpty()) {
    throw new AppError(400, 'VALIDATION_ERROR', result.array()[0].msg);
  }
}