import { Router } from 'express';
import bcrypt from 'bcrypt';
import { body, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { generateToken, authMiddleware } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import { AuthRequest } from '../middleware/auth.middleware';
import { sendNotification } from '../utils/notifications';

const router = Router();

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('rol').isIn(['PROFESIONAL', 'PACIENTE', 'CLINICA']),
    body('nombre').notEmpty().trim(),
    body('apellido').notEmpty().trim(),
    body('telefono').optional().matches(/^[\d\s\-\+\(\)]{8,20}$/),
    body('genero').optional().isIn(['MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(400, 'VALIDATION_ERROR', errors.array()[0].msg);
    }

    const { email, password, rol, nombre, apellido, telefono, genero, matricula, especialidadId, precioConsulta, lugarAtencion, bio, fotoUrl } = req.body;

    const existing = await prisma.usuario.findUnique({ where: { email } });
    if (existing) {
      throw new AppError(400, 'EMAIL_EXISTS', 'El email ya está registrado');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.usuario.create({
      data: {
        email,
        passwordHash,
        rol,
        profesional: rol === 'PROFESIONAL' ? {
          create: {
            nombre,
            apellido,
            telefono: telefono || '',
            genero: genero || 'NO_ESPECIFICADO',
            matricula,
            especialidadId,
            precioConsulta: precioConsulta || 0,
            lugarAtencion: lugarAtencion || null,
            bio: bio || null,
            fotoUrl: fotoUrl || null,
          },
        } : undefined,
        paciente: rol === 'PACIENTE' ? {
          create: {
            nombre,
            apellido,
            email,
            telefono,
            genero: genero || 'NO_ESPECIFICADO',
          },
        } : undefined,
        clinica: rol === 'CLINICA' ? {
          create: {
            nombre: `${nombre} ${apellido}`.trim(),
            telefono: telefono || null,
          },
        } : undefined,
      },
      include: {
        profesional: true,
        paciente: true,
        clinica: true,
      },
    });

    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });

    // Email de bienvenida (fire-and-forget)
    const displayName = rol === 'PROFESIONAL'
      ? `Dr/a. ${nombre} ${apellido}`
      : `${nombre} ${apellido}`;
    sendNotification(['EMAIL'], {
      event: 'BIENVENIDA',
      title: `¡Bienvenido/a a MediSync, ${nombre}!`,
      message: `Tu cuenta fue creada exitosamente. ${
        rol === 'PROFESIONAL'
          ? 'Ya podés configurar tu disponibilidad y empezar a recibir turnos.'
          : rol === 'CLINICA'
            ? 'Ya podés agregar profesionales a tu clínica y gestionar su agenda.'
            : 'Ya podés buscar profesionales y reservar tu primer turno.'
      }`,
      userEmail: email,
      meta: { nombre: displayName, rol },
    }).catch((err) => console.error('[auth] welcome email error:', err));

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.status(201).json(success({ user: { id: user.id, email: user.email, rol: user.rol } }));
  })
);

router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Credenciales inválidas');
    }

    const { email, password } = req.body;

    const user = await prisma.usuario.findUnique({
      where: { email },
      include: { profesional: true, paciente: true },
    });

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    if (!user.passwordHash) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Este usuario se registró con SSO. Iniciá sesión con Google o Microsoft.');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    const perfil = user.profesional || user.paciente;
    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.json(success({ user: { id: user.id, email: user.email, rol: user.rol, perfil } }));
  })
);

router.get('/me', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const authReq = req as AuthRequest;
  const user = await prisma.usuario.findUnique({
    where: { id: authReq.user!.userId },
    include: {
      profesional: { include: { especialidad: true } },
      paciente: true,
      clinica: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'Usuario no encontrado');
  }

  res.json(success(user));
}));

router.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.json(success({ logged_out: true }));
});

// ── SSO Code Exchange Store ──
// Short-lived single-use codes so the JWT never appears in the redirect URL.

interface SSOPendingCode {
  token: string;
  dest: string;
  expiresAt: number; // ms epoch
}

const ssoPendingCodes = new Map<string, SSOPendingCode>();

// Purge expired entries every 60 s to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ssoPendingCodes) {
    if (v.expiresAt < now) ssoPendingCodes.delete(k);
  }
}, 60_000);

function createSSOCode(token: string, dest: string): string {
  const code = crypto.randomUUID();
  ssoPendingCodes.set(code, { token, dest, expiresAt: Date.now() + 30_000 });
  return code;
}

// POST /api/auth/exchange-code  { code } → { token, dest }
router.post('/exchange-code', asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    throw new AppError(400, 'MISSING_CODE', 'Código requerido');
  }

  const entry = ssoPendingCodes.get(code);
  if (!entry) {
    throw new AppError(400, 'INVALID_CODE', 'Código inválido o expirado');
  }
  if (Date.now() > entry.expiresAt) {
    ssoPendingCodes.delete(code);
    throw new AppError(400, 'EXPIRED_CODE', 'Código expirado');
  }

  ssoPendingCodes.delete(code); // single-use
  res.cookie('token', entry.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  res.json(success({ dest: entry.dest }));
}));

// ── SSO Helper ──

interface SSOUserInput {
  provider: 'google' | 'microsoft';
  providerAccountId: string;
  email: string;
  nombre: string;
  apellido: string;
  fotoUrl?: string;
  rol: 'PACIENTE' | 'PROFESIONAL' | 'CLINICA';
}

async function upsertSSOUser({ provider, providerAccountId, email, nombre, apellido, fotoUrl, rol }: SSOUserInput) {
  // 1. Buscar por providerAccountId (prioridad - el email puede cambiar)
  let user = await prisma.usuario.findFirst({
    where: { providerAccountId },
    include: { profesional: true, paciente: true, clinica: true },
  });

  let isNew = false;

  // 2. Si no, buscar por email
  if (!user) {
    const existing = await prisma.usuario.findUnique({ where: { email } });
    if (existing) {
      // Email ya existe con otro provider
      if (existing.provider && existing.provider !== 'local') {
        // Vincular a la cuenta existente del mismo provider
        if (existing.provider === provider) {
          user = await prisma.usuario.findUnique({
            where: { id: existing.id },
            include: { profesional: true, paciente: true, clinica: true },
          });
        } else {
          throw new AppError(409, 'EMAIL_EN_USO', `Este email está registrado con ${existing.provider}`);
        }
      } else if (existing.passwordHash) {
        // Email existe con password - no permitir SSO
        throw new AppError(409, 'EMAIL_EN_USO_CON_PASSWORD', 'Este email ya está registrado con contraseña');
      }
    }
  }

  // 3. Si no existe, crear usuario
  if (!user) {
    isNew = true;
    user = await prisma.usuario.create({
      data: {
        email,
        provider,
        providerAccountId,
        passwordHash: null,
        rol,
        // Para PROFESIONAL, NO creamos la tabla Profesional aún - se hace en completa-perfil
        paciente: rol === 'PACIENTE' ? {
          create: {
            nombre,
            apellido,
            email,
            genero: 'NO_ESPECIFICADO',
            fotoUrl: fotoUrl || null,
          },
        } : undefined,
      },
      include: { profesional: true, paciente: true, clinica: true },
    });
  }

  return { user, isNew };
}

// ── SSO Routes ──

import { getGoogleAuthUrl, exchangeGoogleCode, getMicrosoftAuthUrl, exchangeMicrosoftCode } from '../services/sso.service';
import crypto from 'crypto';

// GET /api/auth/google?rol=PACIENTE|PROFESIONAL
router.get('/google', (req, res) => {
  const rol = String(req.query.rol || 'PACIENTE');
  if (!['PACIENTE', 'PROFESIONAL', 'CLINICA'].includes(rol)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ROL', message: 'Rol inválido' } });
  }

  const state = Buffer.from(JSON.stringify({ rol, nonce: crypto.randomUUID() })).toString('base64');
  const url = getGoogleAuthUrl(state);
  res.redirect(url);
});

// GET /api/auth/google/callback?code=...&state=...
router.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, error, state } = req.query as Record<string, string | undefined>;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${error}`);
  }

  if (!code || !state) {
    throw new AppError(400, 'MISSING_PARAMS', 'Faltan parámetros OAuth');
  }

  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString()) as { rol: string };
    const rol = stateData.rol;
    const googleUser = await exchangeGoogleCode(code);

    const { user, isNew } = await upsertSSOUser({
      provider: 'google',
      providerAccountId: googleUser.sub,
      email: googleUser.email,
      nombre: googleUser.given_name || 'Usuario',
      apellido: googleUser.family_name || 'SSO',
      fotoUrl: googleUser.picture,
      rol: rol as 'PACIENTE' | 'PROFESIONAL' | 'CLINICA',
    });

    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });
    const dest = isNew && user.rol === 'PROFESIONAL' ? '/auth/completa-perfil' : '/dashboard';
    const ssoCode = createSSOCode(token, dest);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?code=${ssoCode}`);
  } catch (err: any) {
    const errorCode = err.code || 'SSO_ERROR';
    const errorMsg = err.message || 'Error en autenticación';
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${errorCode}&msg=${encodeURIComponent(errorMsg)}`);
  }
}));

// GET /api/auth/microsoft?rol=PACIENTE|PROFESIONAL
router.get('/microsoft', (req, res) => {
  const rol = String(req.query.rol || 'PACIENTE');
  if (!['PACIENTE', 'PROFESIONAL', 'CLINICA'].includes(rol)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ROL', message: 'Rol inválido' } });
  }

  const state = Buffer.from(JSON.stringify({ rol, nonce: crypto.randomUUID() })).toString('base64');
  const url = getMicrosoftAuthUrl(state);
  res.redirect(url);
});

// GET /api/auth/microsoft/callback?code=...&state=...
router.get('/microsoft/callback', asyncHandler(async (req, res) => {
  const { code, error, state } = req.query as Record<string, string | undefined>;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${error}`);
  }

  if (!code || !state) {
    throw new AppError(400, 'MISSING_PARAMS', 'Faltan parámetros OAuth');
  }

  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString()) as { rol: string };
    const rol = stateData.rol;
    const microsoftUser = await exchangeMicrosoftCode(code);

    const { user, isNew } = await upsertSSOUser({
      provider: 'microsoft',
      providerAccountId: microsoftUser.sub,
      email: microsoftUser.email,
      nombre: microsoftUser.given_name || 'Usuario',
      apellido: microsoftUser.family_name || 'SSO',
      rol: rol as 'PACIENTE' | 'PROFESIONAL' | 'CLINICA',
    });

    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });
    const dest = isNew && user.rol === 'PROFESIONAL' ? '/auth/completa-perfil' : '/dashboard';
    const ssoCode = createSSOCode(token, dest);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?code=${ssoCode}`);
  } catch (err: any) {
    const errorCode = err.code || 'SSO_ERROR';
    const errorMsg = err.message || 'Error en autenticación';
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${errorCode}&msg=${encodeURIComponent(errorMsg)}`);
  }
}));

export { router as authRouter };
