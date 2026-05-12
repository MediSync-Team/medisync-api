import { Request } from 'express';

/** Parsed pagination parameters extracted from query strings. */
export interface PaginationResult {
  /** 1-based page number (never less than 1) */
  page: number;
  /** Items per page (clamped to maxLimit) */
  limit: number;
  /** Number of rows to skip: `(page - 1) * limit` */
  skip: number;
}

/** Pagination metadata returned alongside paginated results. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Extract pagination parameters from `req.query.page` and `req.query.limit`.
 *
 * @param req - Express request whose query may contain `page` and `limit`.
 * @param defaults - Optional overrides for default page, limit, and maxLimit.
 *   `page` defaults to 1, `limit` to 10, `maxLimit` to 50.
 *   `maxLimit` caps any user-supplied `limit` to prevent excessive queries.
 *
 * @example
 * // In a route handler:
 * const { page, limit, skip } = parsePagination(req);
 * // With custom defaults:
 * const { page, limit, skip } = parsePagination(req, { limit: 20, maxLimit: 100 });
 */
export function parsePagination(req: Request, defaults?: { page?: number; limit?: number; maxLimit?: number }): PaginationResult {
  const page = Math.max(1, Number(req.query.page) || defaults?.page || 1);
  const maxLimit = defaults?.maxLimit ?? 50;
  const limit = Math.min(maxLimit, Number(req.query.limit) || defaults?.limit || 10);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Build a pagination metadata object suitable for API responses.
 *
 * @example
 * res.json(success({ items, pagination: buildPaginationMeta(page, limit, total) }));
 */
export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}