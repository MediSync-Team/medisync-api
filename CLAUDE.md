# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **medisync-api** repo (one of three sibling projects). The big picture below spans all three; sibling repos are referenced via `../medisync-web` and `../medisync-mobile`.

## Workspace layout — three independent projects, NOT a monorepo

Each subdirectory has its own `.git`, `package-lock.json`, and dependency tree. There is no workspace tooling, no shared `node_modules`. Always `cd` into the right project before running any command; installs and scripts do not cascade.

| Project | Stack | Default port | Read first |
|---------|-------|--------------|------------|
| `medisync-api` (this repo) | Express + TypeScript + Prisma + PostgreSQL | 4000 | `AGENTS.md` |
| `medisync-web` | Next.js 16 App Router (Cloudflare Workers deploy) | 3000 | `../medisync-web/AGENTS.md` |
| `medisync-mobile` | Expo ~54 React Native (expo-router) | — | `../medisync-mobile/AGENTS.md` |

The per-project `AGENTS.md` files are the authoritative source for exact commands, scripts, env vars, and quirks — consult them rather than re-deriving. This file captures only the big picture that spans projects.

## Startup order matters

The API must be running before web or mobile are useful: both clients default to `http://localhost:4000/api` (overridable via `NEXT_PUBLIC_API_URL` / `EXPO_PUBLIC_API_URL`). The API also will not start without its `.env` (copy from `.env.example`) — `prisma generate` and `db push` both read `DATABASE_URL` from it.

Full bring-up, from the workspace root (the parent dir of all three repos):

```bash
# Terminal 1: API (must start first)
cd medisync-api && npm install && cp .env.example .env && npx prisma generate && npx prisma db push && npm run seed && npm run dev
# Terminal 2: Web
cd medisync-web && npm install && npm run dev
# Terminal 3: Mobile
cd medisync-mobile && npm install && cp .env.example .env.local && npm start
```

Env files: `.env` (this repo, required — `DATABASE_URL`, `JWT_SECRET`, `PORT`, …), `../medisync-web/.env.local` (optional — `NEXT_PUBLIC_API_URL` overrides default), `../medisync-mobile/.env.local` (required — `EXPO_PUBLIC_API_URL`).

## Domain model (Spanish)

The product is a medical-appointment platform; the domain language throughout code, routes, DB, and UI is **Spanish**. Match it when adding code — do not translate entity names. Core nouns:

- **Usuario** — account, with a `Rol` enum (the four roles drive routing/tabs in every client: patient / professional / clinic / admin).
- **Paciente / Profesional / Clinica** — role-specific profiles attached to a Usuario.
- **Turno** — an appointment; central entity with an `EstadoTurno` state machine (see `src/utils/turno-state.ts`).
- **Disponibilidad / BloqueoDisponibilidad** — a professional's bookable slots and exceptions; slot math lives in `src/services/slot-availability.service.ts`.
- **Pago / Cupon / Suscripcion** — payments (MercadoPago), discount coupons, professional plans.
- **ListaEspera** — waitlist that auto-expires.
- **Evolucion / RecetaIndicacion / CertificadoMedico / Archivo** — clinical records, prescriptions, certificates, uploads.

Full schema + all enums: `prisma/schema.prisma`. After editing it, run `npx prisma db push` (and regenerate the client). For non-local envs this repo ships wrapper scripts that load the right env file: `npm run db:push:dev`, `db:push:prod`, `db:migrate:deploy` (see `scripts/`).

## API architecture

`src/index.ts` is the single entrypoint: mounts all routers under the `/api` prefix, sets up the WebSocket video-signaling server at `ws://<host>/ws/video`, creates the `/uploads` static dir, and registers three cron jobs (reminders ~30m, waitlist expiry ~30m, stale-reservation cleanup ~15m).

Layering convention:
- `src/routes/*.routes.ts` — one router per domain area (turnos, pagos, profesionales, …); thin, handle HTTP.
- `src/services/*` — business logic with side effects (notifications, push, reminders, waitlist, slot availability, Google Calendar sync, video rooms).
- `src/utils/*` — pure helpers (appointment conflict/lock logic, coupon redemption, pagination, the `turno-state` machine, response shaping).
- `src/middleware/` — `auth.middleware.ts` (JWT) and `error.middleware.ts`.
- `src/lib/prisma.ts` — the shared Prisma client; import it, don't `new PrismaClient()`.

Auth is JWT-based across the board: cookies on the API, `next-auth`-style flow on web, `expo-secure-store` on mobile.

**AI triage (Preconsulta Inteligente)** — `src/services/preconsulta.service.ts` scores patient intake (riesgo BAJO/MEDIO/ALTO/URGENTE). It calls **OpenRouter** (`OPENROUTER_API_KEY`, `https://openrouter.ai/api/v1/chat/completions`), iterating a list of free models and falling through on 429/5xx, then a local heuristic fallback when no key/all fail. Note: despite the `@google/generative-ai` dep and `src/scripts/test-gemini.ts` name, the live path is OpenRouter, not Gemini.

## Web ↔ API contract

`../medisync-web/app/lib/api/` is the single API client (`core.ts` = fetch wrapper + base URL, `types.ts` = shared types, `index.ts` = re-exports); the mobile `../medisync-mobile/src/api/` layer deliberately mirrors the same surface. The web app is App-Router with role-segmented dashboards (`../medisync-web/app/dashboard/{admin,clinica,paciente}`) and public routes for professional profiles, payment result pages, and invitations.

Two things that look odd but are intentional:
- `../medisync-web/app/widget/*` and `../medisync-web/app/api/pagos/webhook/` — the widget routes ship permissive iframe/CSP headers (`../medisync-web/next.config.ts`) so clinics can embed booking; the webhook route is a thin proxy forwarding MercadoPago callbacks to the API.
- Web Tailwind is **v4** (via `@tailwindcss/postcss`), not v3 — class/config conventions differ.

## Mobile architecture

`expo-router` file-based navigation rooted at `../medisync-mobile/app/`, split into `(auth)` (login/register/forgot-password) and `(app)` route groups; `(app)` holds the authenticated screens (dashboard, turno, profesional, pago, preconsulta, notifications) and the patient/professional/clinic/admin role decides which dashboard renders. Shared client code lives under `../medisync-mobile/src/` (`api/` mirrors the web client, plus contexts Auth/Theme/Language, hooks, `i18n/` ES/EN, theme, components). Deep link scheme: `medisync://`.

## Testing

| Project | Command | Framework |
|---------|---------|-----------|
| `medisync-api` | `npm test` / `npm run test:watch` | Jest + Supertest |
| `medisync-api` | `npm run test:bdd` | Cucumber (BDD/E2E) |
| `medisync-api` | `npm run test:load` | k6 load tests (`load_tests/test.js`) |
| `medisync-web` | `npm test` / `test:watch` / `test:ui` | Vitest + Testing Library (JSDOM) |
| `medisync-web` | `npm run test:e2e` / `test:e2e:ui` | Playwright |
| `medisync-mobile` | — | no test suite (only `npm run typecheck`) |

Run a single API test: `npm test -- path/to/file.test.ts` (or `-t "name"`). Single web test: `npm test -- path/to/file.test.tsx`. Coverage: `npm run test:coverage` in either project.

`medisync-api` and `medisync-web` each have a `npm run check` gate — run it before considering a change done:

- API: `typecheck → test → build` (tsc)
- Web: `typecheck → vitest run → build` (next build --webpack)

## DB safety

- Never run Prisma commands against production unless explicitly asked. Local dev uses `.env` / `.env.development`; production uses `.env.production` (never committed).
- Do not run `prisma db push` against Neon without the guarded `npm run db:push:prod` script.
- Prefer `prisma migrate deploy` for production once migrations exist.
- Never use `--force-reset`, `--accept-data-loss`, or destructive migration flags on production.

## Notification stack

Four channels, all optional (graceful no-op when keys missing):

- **Email**: Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`)
- **WhatsApp**: Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`)
- **Web push**: `web-push` (`NEXT_PUBLIC_VAPID_PUBLIC_KEY` on web, VAPID keys on API)
- **Mobile push**: `expo-server-sdk` (Expo push tokens)

See `PRODUCTION_NOTIFICATIONS.md` for full flows. Smoke test: `npm run smoke:sprint1`.

## Videocall dev constraints

- Uses native WebRTC (`react-native-webrtc`) — **cannot run in Expo Go**, need `npx expo run:ios` / `run:android` dev build.
- Signaling is **in-memory** (`src/services/video-room.service.ts`): single API instance required, API restart drops all active calls.
- Join endpoint (`GET /turnos/:id/video-token`) only issues tickets for VIRTUAL turnos in `RESERVADO`/`CONFIRMADO` state within the join window (15 min before → end of appointment). Returns `403 OUTSIDE_JOIN_WINDOW` otherwise — seed/reschedule turno to "now" when testing.
- ICE defaults to STUN-only (same-network only). Cross-NAT needs `CLOUDFLARE_TURN_TOKEN_ID` + `CLOUDFLARE_TURN_API_TOKEN`.

## Version gotchas (these break naively-written code)

- **Next.js 16** has breaking changes — read `../medisync-web/node_modules/next/dist/docs/` before writing App Router code.
- **Expo 54** — use the versioned docs at `docs.expo.dev/versions/v54.0.0/`.
- API request body is capped at **50kb** (returns 413). Auth routes are rate-limited to 20 req / 15 min (general: 200 / 15 min).
