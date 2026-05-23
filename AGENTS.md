# MediSync API — Project Notes (AGENTS)

## Overview
MediSync is a backend API for medical scheduling and care workflows (patients, professionals, clinics). It provides authentication, appointment booking, payments, notifications, chat, and optional video consultations with integrations like Mercado Pago and Google Calendar.

## Stack
- Node.js + Express + TypeScript
- Prisma ORM with PostgreSQL
- JWT auth + bcrypt
- Jest + Supertest for tests

## Local setup (from README)
1. `npm install`
2. `cp .env.example .env`
3. `npx prisma generate`
4. `npx prisma db push`
5. `npm run seed`
6. `npm run dev`

## NPM scripts
- `dev`: `tsx watch src/index.ts`
- `build`: `tsc`
- `start`: `node dist/index.js`
- `seed`: `tsx prisma/seed.ts`
- `smoke:sprint1`: `tsx src/scripts/smoke-sprint1.ts`
- `lint`: `eslint src --ext .ts`
- `test`: `jest`
- `test:watch`: `jest --watch`

## API entrypoint & infrastructure
- Main entry: `src/index.ts`
- Base API prefix: `/api`
- Health check: `GET /api/health`
- WebSocket signaling: `ws://<host>/ws/video`
- Static uploads: `/uploads` (created on startup if missing)
- CORS is configured with `FRONTEND_URL` / `FRONTEND_URLS`
- Rate limiting on API and stricter limiter for auth routes
- Cron jobs:
  - Reminders every 30 min (`sendUpcomingAppointmentsReminders`)
  - Waitlist expiry every 30 min (`expireStaleWaitlistNotifications`)
  - Cleanup stale reservations every 15 min (`cleanupStaleReservations`)

## Routes (high level)
`src/routes` exposes:
- Auth & SSO: `auth.routes.ts`
- Especialidades, Profesionales, Pacientes
- Turnos (appointments), Pagos (payments), Archivos
- Dashboard profesional
- Recordatorios, Notificaciones
- Lista de espera, Reseñas, Bloqueos
- Certificados, Cupones, Suscripciones
- Admin, Chat
- Google (calendar/auth), Clínicas, Obras sociales

## Core features observed
- **Auth**: JWT + cookies; account lockout after repeated failed logins
- **SSO**: Google OAuth flow (and Microsoft placeholder) with short-lived exchange codes
- **Appointments**: booking, reschedule/cancel, reminders, cleanup of stale reservations
- **Payments**: Mercado Pago integration
- **Notifications**:
  - In-app notifications with SSE
  - Web Push (per-user preference flags)
  - Email/WhatsApp via Resend + Twilio in production
- **Video consults**: WebRTC signaling via WebSocket with short-lived tickets
- **Google Calendar**: OAuth + event create/update/delete
- **Files**: uploads for clinical records
- **Waitlist**: queue + expiry workflow
- **Reviews & certificates**: patient reviews, medical certificates, prescriptions

## Services (src/services)
- `appointment-cleanup.service.ts`: stale booking cleanup
- `calendar-sync.service.ts` / `google-calendar.service.ts`: calendar auth + event sync
- `notification.service.ts`: DB + SSE + Web Push dispatch
- `preconsulta.service.ts`: pre-consultation logic
- `reminder.service.ts`: appointment reminders
- `slot-availability.service.ts`: availability computation
- `sso.service.ts`: Google SSO helper
- `video-room.service.ts`: WebRTC signaling rooms
- `waitlist.service.ts`: waitlist notifications/expiry
- `web-push.service.ts`: Web Push delivery

## Data model (Prisma highlights)
Key entities in `prisma/schema.prisma`:
- **Usuario** with roles: `PROFESIONAL`, `PACIENTE`, `ADMIN`, `CLINICA`
- **Profesional**, **Paciente**, **Clinica**, **Especialidad**
- **Turno** (appointments) with states and pre-consultation fields
- **Disponibilidad** and **BloqueoDisponibilidad**
- **Pago**, **Cupon**
- **ListaEspera**
- **Resena**
- **Notificacion** and **PushSubscription**
- **ChatMensaje**
- **CertificadoMedico**, **RecetaIndicacion**, **Evolucion**
- **Archivo** (uploaded documents)
- **PasswordResetToken**, **BookingVerification**
- **AuditoriaDisponibilidad** for availability event audits

## Environment variables (summary)
From `.env.example` + production notifications doc:
- Database: `DATABASE_URL`
- Auth: `JWT_SECRET`
- Server: `PORT`, `NODE_ENV`
- URLs: `FRONTEND_URL`, `FRONTEND_URLS`, `BACKEND_URL`
- Cloudinary: `CLOUDINARY_URL`
- Mercado Pago: `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`
- Notifications: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- Optional observability: `NOTIFICATIONS_WEBHOOK_URL`
- Notifications runtime flags: `NOTIFICATIONS_ENABLED`, `NOTIFICATIONS_TIMEOUT_MS`
- Business rules: `CANCELLATION_WINDOW_HOURS`
- Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- Google SSO (used in `sso.service.ts`): `GOOGLE_SSO_CLIENT_ID`, `GOOGLE_SSO_CLIENT_SECRET`

## Production notifications (PRODUCTION_NOTIFICATIONS.md)
- Providers: **Resend** (Email) and **Twilio WhatsApp**
- Events covered: booking, reschedule, cancellation, payment approved, automated reminders
- Includes smoke test `npm run smoke:sprint1` with env vars for patient credentials
