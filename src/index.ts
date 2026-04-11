import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { authRouter } from './routes/auth.routes';
import { especialidadesRouter } from './routes/especialidades.routes';
import { profesionalesRouter } from './routes/profesionales.routes';
import { turnosRouter } from './routes/turnos.routes';
import { pagosRouter } from './routes/pagos.routes';
import { archivosRouter } from './routes/archivos.routes';
import { dashboardRouter } from './routes/dashboard.routes';
import { recordatoriosRouter } from './routes/recordatorios.routes';
import { pacientesRouter } from './routes/pacientes.routes';
import { errorHandler } from './middleware/error.middleware';
import { sendUpcomingAppointmentsReminders } from './services/reminder.service';

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Demasiados intentos. Intenta mas tarde.' } },
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

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 API: http://localhost:${PORT}/api`);
});

cron.schedule('0 * * * *', async () => {
  try {
    await sendUpcomingAppointmentsReminders();
  } catch (err) {
    console.error('[reminders] scheduled job error:', err);
  }
});

export default app;
