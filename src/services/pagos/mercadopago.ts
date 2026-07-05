import crypto from 'crypto';

/**
 * Error thrown by the low-level MercadoPago REST calls, carrying the HTTP status
 * so callers can react to it — e.g. refresh an expired seller token on 401 (see
 * `mp-credentials.ts`). Higher layers (payment/webhook services) catch this and
 * remap it to their own `AppError`.
 */
export class MpApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MpApiError';
    this.status = status;
  }
}

export interface MercadoPagoPreferenceResponse {
  id: string;
  init_point: string;
  error?: { message?: string };
  message?: string;
}

export interface MercadoPagoWebhookBody {
  type?: string;
  data?: {
    id?: string | number;
  };
}

export interface MercadoPagoPaymentResponse {
  id?: number | string;
  external_reference?: string;
  status?: string;
  transaction_amount?: number;
}

/**
 * Create a MercadoPago checkout preference. `accessToken` selects the receiving
 * account — pass the professional's linked token for split payments, or omit it
 * to fall back to the platform token. Throws {@link MpApiError} (carrying the HTTP
 * status) when MP responds with an error; callers wrap this in their own try/catch
 * (see `payment.service.ts`), so the surfaced status is ultimately theirs.
 */
export async function createMpPreference(
  preferenceData: Record<string, unknown>,
  accessToken: string = process.env.MP_ACCESS_TOKEN || '',
): Promise<MercadoPagoPreferenceResponse> {
  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(preferenceData),
  });

  const data = await response.json() as MercadoPagoPreferenceResponse;

  if (!response.ok || data.error) {
    const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
    console.error('MP Error:', errorMsg);
    throw new MpApiError(response.ok ? 400 : response.status, errorMsg);
  }

  return data;
}

/**
 * Fetch a MercadoPago payment by id. `accessToken` must be the token of the
 * account that owns the payment (the seller's, for split payments; the platform's
 * otherwise). Throws {@link MpApiError} on a non-OK response.
 */
export async function fetchMpPayment(
  paymentId: string | number,
  accessToken: string = process.env.MP_ACCESS_TOKEN || '',
): Promise<MercadoPagoPaymentResponse> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new MpApiError(response.status, `Mercado Pago payment fetch failed with status ${response.status}`);
  }

  return await response.json() as MercadoPagoPaymentResponse;
}

export interface MercadoPagoRefundResponse {
  id: string | number;
  status?: string;
}

/**
 * Refund a MercadoPago payment in full (empty body = total refund; partial
 * refunds are out of scope for v1). `accessToken` must be the token of the
 * account that collected the payment (the seller's, for split payments) — MP
 * rejects refunds issued with any other account. On a full refund MP also
 * returns the `marketplace_fee` to the payer. `idempotencyKey` guards against
 * double-submission via the `X-Idempotency-Key` header. Throws {@link MpApiError}
 * on a non-OK response so `callMpWithRefresh` can retry an expired seller token.
 */
export async function refundMpPayment(
  paymentId: string | number,
  accessToken: string = process.env.MP_ACCESS_TOKEN || '',
  idempotencyKey?: string,
): Promise<MercadoPagoRefundResponse> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new MpApiError(response.status, `Mercado Pago refund failed with status ${response.status}`);
  }

  return await response.json() as MercadoPagoRefundResponse;
}

export interface MercadoPagoSearchResponse {
  results?: MercadoPagoPaymentResponse[];
}

/**
 * Search a seller's payments by `external_reference` (= turnoId), newest first.
 * Used by the `/pago-exitoso` reconciliation to find an approved payment when the
 * webhook has not arrived yet. `accessToken` must own the payments (the seller's
 * token for split payments). Throws {@link MpApiError} on a non-OK response.
 */
export async function searchMpPaymentsByExternalReference(
  externalReference: string,
  accessToken: string = process.env.MP_ACCESS_TOKEN || '',
): Promise<MercadoPagoSearchResponse> {
  const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&external_reference=${encodeURIComponent(externalReference)}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new MpApiError(response.status, `Mercado Pago payment search failed with status ${response.status}`);
  }

  return await response.json() as MercadoPagoSearchResponse;
}

function parseSignatureHeader(signature: string) {
  const parts = signature.split(',').map((p) => p.trim());
  let ts = '';
  let v1 = '';

  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key === 'ts') ts = value || '';
    if (key === 'v1') v1 = value || '';
  }

  return { ts, v1 };
}

/**
 * Verify a MercadoPago webhook signature against the `x-signature` / `x-request-id`
 * header values. Returns `true` when no `MP_WEBHOOK_SECRET` is configured (dev mode).
 */
export function isValidWebhookSignature(
  signature: string | undefined,
  requestId: string | undefined,
  dataId: string,
): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  if (typeof signature !== 'string' || typeof requestId !== 'string') {
    return false;
  }

  const { ts, v1 } = parseSignatureHeader(signature);
  if (!ts || !v1) {
    return false;
  }

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return hash === v1;
}
