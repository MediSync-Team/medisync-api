import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { WebSocketServer } from 'ws';
import { handleVideoConnection } from './services/video-room.service';
import { authRouter } from './routes/auth.routes';
import { especialidadesRouter } from './routes/especialidades.routes';
import { profesionalesRouter } from './routes/profesionales.routes';
import { turnosRouter } from './routes/turnos.routes';
import { pagosRouter } from './routes/pagos.routes';
import { archivosRouter } from './routes/archivos.routes';
import { dashboardRouter } from './routes/dashboard.routes';
import { recordatoriosRouter } from './routes/recordatorios.routes';
import { pacientesRouter } from './routes/pacientes.routes';
import { notificationsRouter } from './routes/notifications.routes';
import { listaEsperaRouter } from './routes/lista-espera.routes';
import { resenasRouter } from './routes/resenas.routes';
import { bloqueosRouter } from './routes/bloqueos.routes';
import { adminRouter } from './routes/admin.routes';
import { chatRouter } from './routes/chat.routes';
import { googleRouter } from './routes/google.routes';
import { clinicasRouter } from './routes/clinicas.routes';
import { certificadosRouter } from './routes/certificados.routes';
import { cuponesRouter } from './routes/cupones.routes';
import { suscripcionesRouter } from './routes/suscripciones.routes';
import { errorHandler } from './middleware/error.middleware';
import { sendUpcomingAppointmentsReminders } from './services/reminder.service';
import { expireStaleWaitlistNotifications } from './services/waitlist.service';

const app = express();
const PORT = process.env.PORT || 4000;
const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS no permitido'));
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '50kb' })); // Prevent memory exhaustion; larger payloads rejected with 413
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Demasiados intentos fallidos. Intenta más tarde.' } },
  skip: (req) => {
    // Don't rate limit registration, password reset, or email verification
    return ['/api/auth/register', '/api/auth/reset-password', '/api/auth/verify-email'].includes(req.path);
  },
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/especialidades', especialidadesRouter);
app.use('/api/profesionales', profesionalesRouter);
app.use('/api/turnos', turnosRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/archivos', archivosRouter);
app.use('/api/profesional', dashboardRouter);
app.use('/api/recordatorios', recordatoriosRouter);
app.use('/api/pacientes', pacientesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/lista-espera', listaEsperaRouter);
app.use('/api/resenas', resenasRouter);
app.use('/api/bloqueos', bloqueosRouter);
app.use('/api/certificados', certificadosRouter);
app.use('/api/cupones', cuponesRouter);
app.use('/api/suscripciones', suscripcionesRouter);
app.use('/api/admin', adminRouter);
app.use('/api/chat', chatRouter);
app.use('/api/google', googleRouter);
app.use('/api/clinicas', clinicasRouter);

app.use(errorHandler);

// ── HTTP server + WebSocket signaling ──────────────────────────────────────
const httpServer = http.createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/ws/video' });
wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const ticket = url.searchParams.get('ticket') ?? '';
    handleVideoConnection(ws, ticket);
  } catch {
    ws.close(4000, 'Bad request');
  }
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 API: http://localhost:${PORT}/api`);
  console.log(`📹 Video WS: ws://localhost:${PORT}/ws/video`);
});

cron.schedule('*/30 * * * *', async () => {
  try {
    await sendUpcomingAppointmentsReminders();
  } catch (err) {
    console.error('[reminders] scheduled job error:', err);
  }
});

cron.schedule('*/30 * * * *', async () => {
  try {
    await expireStaleWaitlistNotifications();
  } catch (err) {
    console.error('[waitlist] expiry job error:', err);
  }
});

export default app;
