# MediSync - Notificaciones en Produccion

Este documento deja lista la configuracion de notificaciones reales para Sprint 1.

## Proveedores

- Email: Resend
- WhatsApp: Twilio WhatsApp API

## Variables de entorno requeridas

Configuralas en `medisync-api/.env` (desarrollo) o en el entorno de despliegue:

```env
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM_EMAIL=MediSync <no-reply@yourdomain.com>

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

CANCELLATION_WINDOW_HOURS=24
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_TIMEOUT_MS=10000
```

Opcional para trazabilidad interna:

```env
NOTIFICATIONS_WEBHOOK_URL=https://your-observability-endpoint.example.com/notifications
```

## Flujo implementado

Se envian notificaciones en estos eventos:

- Reserva de turno
- Reprogramacion de turno
- Cancelacion de turno
- Pago aprobado
- Recordatorio automatico (cron cada hora para turnos de proximas 24h)

## Checklist de puesta en marcha

1. Verificar dominio remitente en Resend y usarlo en `RESEND_FROM_EMAIL`.
2. Habilitar sandbox o numero productivo de WhatsApp en Twilio.
3. Cargar variables en entorno de backend y reiniciar servicio.
4. Probar un turno end-to-end (reserva -> pago -> confirmacion).
5. Validar logs de backend y delivery en paneles de Resend/Twilio.

## Endpoint de prueba manual

Con token de usuario autenticado:

```bash
curl -X POST https://api.example.com/api/notifications/test \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"canal":"EMAIL","mensaje":"Prueba de canal"}'
```

Canales soportados: `EMAIL`, `WHATSAPP`, `IN_APP`.

## Smoke test automatizado (Sprint 1)

Se agrego un smoke test para validar de punta a punta:

- login paciente
- reserva
- reprogramacion
- politica de cancelacion
- estado de pago
- cancelacion

### Variables para ejecutar

```env
SMOKE_API_BASE_URL=https://api.example.com/api
SMOKE_PACIENTE_EMAIL=paciente@test.com
SMOKE_PACIENTE_PASSWORD=tu-password
```

### Comando

```bash
npm run smoke:sprint1
```

## Nota

Si falta configuracion de proveedor, el sistema no rompe el flujo clinico ni de pagos; registra warning y continua.
