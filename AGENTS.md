# MediSync API

## Stack
Node.js + Express + TypeScript, Prisma ORM, PostgreSQL, JWT + bcrypt. Jest + Supertest for tests.

## Local setup (exact order)
1. `npm install`
2. `cp .env.example .env`
3. `npx prisma generate`
4. `npx prisma db push`
5. `npm run seed`
6. `npm run dev`

## Scripts
| Script | Command |
|--------|---------|
| `dev` | `tsx watch src/index.ts` |
| `build` | `tsc` → `dist/index.js` |
| `start` | `node dist/index.js` |
| `seed` | `tsx prisma/seed.ts` |
| `smoke:sprint1` | `tsx src/scripts/smoke-sprint1.ts` |
| `lint` | `eslint src --ext .ts` |
| `test` / `test:watch` | `jest` / `jest --watch` |

## Entrypoint & infra
- Main: `src/index.ts`
- Base prefix: `/api`
- Health: `GET /api/health`
- WebSocket signaling: `ws://<host>/ws/video`
- Static uploads: `/uploads` (created on startup if missing)

## Cron jobs (defined in `src/index.ts`)
- Reminders: every 30 min
- Waitlist expiry: every 30 min
- Stale reservation cleanup: every 15 min

## Rate limiting
- General: 200 requests / 15 min
- Auth routes: 20 / 15 min (skips `/api/auth/register`, `/api/auth/reset-password`, `/api/auth/verify-email`)

## Body limits
- `express.json` and `urlencoded` capped at `50kb` — returns 413 if exceeded.

## CORS
- Origins from `FRONTEND_URL` / `FRONTEND_URLS`; loopback allowed in non-production.

## Key env vars
- `DATABASE_URL`, `JWT_SECRET`, `PORT`, `NODE_ENV`
- `FRONTEND_URL`, `FRONTEND_URLS`, `BACKEND_URL`
- `CLOUDINARY_URL`
- `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `GOOGLE_SSO_CLIENT_ID`, `GOOGLE_SSO_CLIENT_SECRET`
- `CANCELLATION_WINDOW_HOURS`
- `CLOUDFLARE_TURN_TOKEN_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `TURN_TTL_SECONDS` (video TURN relay; STUN-only fallback if unset)
- `NOTIFICATIONS_ENABLED`, `NOTIFICATIONS_TIMEOUT_MS`, `NOTIFICATIONS_WEBHOOK_URL`

## Production notifications
- See `PRODUCTION_NOTIFICATIONS.md` for Resend + Twilio WhatsApp flows.
- Smoke test: `npm run smoke:sprint1` (needs patient credentials in env).
