import crypto from 'crypto';
import { AppError } from '../../utils/response';

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
  external_reference?: string;
  status?: string;
  transaction_amount?: number;
}

/**
 * Create a MercadoPago checkout preference. Throws `AppError(400, 'MP_ERROR')`
 * when MP responds with an error — note callers wrap this in their own try/catch
 * (see `payment.service.ts`), so the surfaced status is ultimately theirs.
 */
export async function createMpPreference(preferenceData: Record<string, unknown>): Promise<MercadoPagoPreferenceResponse> {
  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(preferenceData),
  });

  const data = await response.json() as MercadoPagoPreferenceResponse;

  if (!response.ok || data.error) {
    const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
    console.error('MP Error:', errorMsg);
    throw new AppError(400, 'MP_ERROR', errorMsg);
  }

  return data;
}

/** Fetch a MercadoPago payment by id. Throws a plain Error on a non-OK response. */
export async function fetchMpPayment(paymentId: string | number): Promise<MercadoPagoPaymentResponse> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: {
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Mercado Pago payment fetch failed with status ${response.status}`);
  }

  return await response.json() as MercadoPagoPaymentResponse;
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
