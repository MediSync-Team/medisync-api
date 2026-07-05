# Mercado Pago — Checklist de producción

Estado de la integración: Checkout Pro por turno, vinculación de cuenta propia por profesional (OAuth marketplace, split con `marketplace_fee`), reembolso automático al cancelar turnos pagados, suscripción PRO por preapproval y cron de vencimiento. Este checklist cubre lo que hay que configurar **fuera del código** para operar en producción.

## 1. Aplicación Marketplace en Mercado Pago

- [ ] Crear una aplicación en <https://www.mercadopago.com.ar/developers/panel> de tipo **Marketplace** (modelo "pagos para terceros"), país Argentina.
- [ ] Copiar `Client ID` → `MP_CLIENT_ID` y `Client Secret` → `MP_CLIENT_SECRET`.
- [ ] Copiar el **Access Token de producción** de la cuenta plataforma → `MP_ACCESS_TOKEN` (es el fallback cuando un profesional no vinculó su cuenta, y el cobrador de las suscripciones PRO).

## 2. OAuth (vinculación de cuenta del profesional)

- [ ] Registrar en la app de MP la Redirect URI **HTTPS**: `https://<backend>/api/mercadopago/oauth/callback`.
- [ ] Setear `MP_OAUTH_REDIRECT_URI` con exactamente el mismo valor (deben coincidir carácter a carácter).

## 3. Webhooks

- [ ] Configurar en el panel de MP la URL de notificaciones de pagos: `https://<backend>/api/pagos/webhook` (evento `payment`). La app agrega `?turnoId=...` por preferencia vía `notification_url`, pero la URL del panel actúa de respaldo.
- [ ] Configurar la URL del webhook de suscripciones: `https://<backend>/api/suscripciones/webhook` (evento `subscription_preapproval`).
- [ ] Copiar la **clave secreta** del panel de webhooks → `MP_WEBHOOK_SECRET`. ⚠️ Sin esta variable la validación de firma queda deshabilitada (solo aceptable en dev).
- [ ] Pendiente de hardening: `POST /api/suscripciones/webhook` hoy no valida firma (el de pagos sí). Agregar el mismo check `isValidWebhookSignature` cuando se priorice.

## 4. Comisión de la plataforma

- [ ] Decidir el porcentaje de comisión sobre los pagos con cuenta vinculada → `MP_MARKETPLACE_FEE_PERCENT` (número, ej. `10` = 10%). Con `0` (default) no se cobra comisión. Solo aplica cuando el pago entra a la cuenta del profesional (split); con el token plataforma no hay fee.

## 5. Cifrado de tokens

- [ ] Generar `TOKEN_ENCRYPTION_KEY` (32 bytes hex): `openssl rand -hex 32`.
- [ ] ⚠️ Rotar esta clave invalida los tokens ya guardados de todos los profesionales vinculados (MP y Google) — obligaría a re-vincular.

## 6. URLs

- [ ] `BACKEND_URL` — **obligatoria en producción**: de acá sale la `notification_url` de cada preferencia (no hay fallback al header Host en prod).
- [ ] `FRONTEND_URL` / `FRONTEND_URLS` — CORS + `back_urls` de Checkout Pro (`/pago-exitoso`, `/pago-fallido`, `/pago-pendiente`) y redirects del OAuth.

## 7. Base de datos

- [ ] Aplicar la migración `prisma/migrations/20260701_add_pago_refund_fields` (agrega `pago.mp_refund_id` y `pago.reembolsado_at`, columnas nullable — operación aditiva). Procedimiento: branch de respaldo en Neon → `npm run db:migrate:deploy` (usa `.env.production`). **El código de reembolsos requiere estas columnas antes de deployar.**

## 8. Pasada de prueba en sandbox (antes del go-live)

Con usuarios de prueba de MP (un vendedor y un comprador, se crean desde el panel de developers):

- [ ] Vinculación OAuth del profesional (conectar y desconectar desde el perfil en la web).
- [ ] Checkout de un turno con cuenta vinculada → verificar que el dinero entra a la cuenta del vendedor y que el `marketplace_fee` queda para la plataforma.
- [ ] Webhook de aprobación → turno CONFIRMADO + notificación al paciente.
- [ ] Cancelar el turno pagado → verificar reembolso total automático, pago REEMBOLSADO, y **que el `marketplace_fee` se devuelve completo en el reembolso total** (supuesto a confirmar en sandbox).
- [ ] Reembolso iniciado desde el panel de MP sobre un turno vigente → el webhook cancela el turno y notifica.
- [ ] Suscripción PRO: alta (preapproval `authorized` → plan PRO), cancelación (PRO se mantiene hasta `planVenceAt`), vencimiento (cron horario baja a FREE).
