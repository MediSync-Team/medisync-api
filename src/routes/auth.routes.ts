import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { generateToken, authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import { sendNotification } from '../utils/notifications';
import { setTokenCookie } from '../utils/auth-helpers';
import { validateRequest } from '../utils/validation';

const router = Router();

const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
const strongPasswordMessage = 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un carácter especial';

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').matches(STRONG_PASSWORD_REGEX).withMessage(strongPasswordMessage),
    body('rol').isIn(['PROFESIONAL', 'PACIENTE', 'CLINICA']),
    body('nombre').notEmpty().trim(),
    body('apellido').notEmpty().trim(),
    body('telefono').optional().matches(/^[\d\s\-\+\(\)]{8,20}$/),
    body('genero').optional().isIn(['MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO']),
  ],
  asyncHandler(async (req, res) => {
    validateRequest(validationResult(req));

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

    setTokenCookie(res, token);
    res.status(201).json(success({ token, user: { id: user.id, email: user.email, rol: user.rol } }));
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

    // Check if account is locked (even for nonexistent users to prevent enumeration)
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new AppError(429, 'ACCOUNT_LOCKED', `Cuenta bloqueada. Intenta en ${remainingMinutes} minuto${remainingMinutes !== 1 ? 's' : ''}.`);
    }

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    if (!user.passwordHash) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Este usuario se registró con SSO. Iniciá sesión con Google o Microsoft.');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      // Increment failed login attempts and lock if necessary
      const newFailedAttempts = (user.failedLoginAttempts || 0) + 1;
      const lockedUntil = newFailedAttempts >= 10
        ? new Date(Date.now() + 15 * 60 * 1000) // Lock for 15 minutes
        : null;

      await prisma.usuario.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: newFailedAttempts,
          lockedUntil,
          lastFailedLoginAt: new Date(),
        },
      });

      if (lockedUntil) {
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.');
      }

      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    // Reset failed attempts on successful login
    await prisma.usuario.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      },
    });

    const perfil = user.profesional || user.paciente;
    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });

    setTokenCookie(res, token);
    res.json(success({ token, user: { id: user.id, email: user.email, rol: user.rol, perfil } }));
  })
);

router.get('/me', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const user = await prisma.usuario.findUnique({
    where: { id: req.user!.userId },
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

// ── Password Reset ──

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Email inválido');
    }

    const { email } = req.body;
    const user = await prisma.usuario.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (!user) {
      res.json(success({ message: 'Si el email está registrado, recibirás un enlace de recuperación.' }));
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');

    await prisma.passwordResetToken.create({
      data: {
        email,
        token,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const baseUrl = (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const resetUrl = `${baseUrl}/forgot-password?token=${token}`;

    console.log(`[auth] Reset link for ${email}: ${resetUrl}`);

    sendNotification(['EMAIL'], {
      event: 'RECUPERAR_CONTRASENA',
      title: 'Recuperá tu contraseña',
      message: 'Hacé clic en el botón de abajo para restablecer tu contraseña. El enlace expira en 1 hora.',
      userEmail: email,
      meta: { resetUrl },
    }).catch((err) => console.error('[auth] reset email error:', err));

    res.json(success({ message: 'Si el email está registrado, recibirás un enlace de recuperación.' }));
  })
);

router.post(
  '/reset-password',
  [
    body('token').notEmpty(),
    body('newPassword').matches(STRONG_PASSWORD_REGEX).withMessage(strongPasswordMessage),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Token o contraseña inválidos');
    }

    const { token, newPassword } = req.body;

    const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });

    if (!resetToken || resetToken.usado || resetToken.expiresAt < new Date()) {
      throw new AppError(400, 'INVALID_TOKEN', 'El enlace de recuperación es inválido o expiró');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.usuario.update({
        where: { email: resetToken.email },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usado: true },
      }),
    ]);

    res.json(success({ message: 'Contraseña restablecida correctamente' }));
  })
);

// ── SSO Code Exchange Store ──
// Short-lived single-use codes so the JWT never appears in the redirect URL.

interface SSOPendingCode {
  token: string;
  dest: string;
  expiresAt: number; // ms epoch
}

interface OAuthNonce {
  rol: string;
  expiresAt: number; // ms epoch
}

const ssoPendingCodes = new Map<string, SSOPendingCode>();
const oauthNonces = new Map<string, OAuthNonce>();

// Purge expired entries every 60 s to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ssoPendingCodes) {
    if (v.expiresAt < now) ssoPendingCodes.delete(k);
  }
  for (const [k, v] of oauthNonces) {
    if (v.expiresAt < now) oauthNonces.delete(k);
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
  setTokenCookie(res, entry.token);
  res.json(success({ token: entry.token, dest: entry.dest }));
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

import { getGoogleAuthUrl, exchangeGoogleCode } from '../services/sso.service';

// GET /api/auth/google?rol=PACIENTE|PROFESIONAL
router.get('/google', (req, res) => {
  const rol = String(req.query.rol || 'PACIENTE');
  if (!['PACIENTE', 'PROFESIONAL', 'CLINICA'].includes(rol)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_ROL', message: 'Rol inválido' } });
  }

  const nonce = crypto.randomUUID();
  oauthNonces.set(nonce, { rol, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min TTL
  res.cookie('oauth_nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const state = Buffer.from(JSON.stringify({ nonce })).toString('base64');
  const url = getGoogleAuthUrl(state);
  res.redirect(url);
});

// GET /api/auth/google/callback?code=...&state=...
router.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, error, state } = req.query as Record<string, string | undefined>;
  const cookieNonce = req.cookies?.oauth_nonce;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${error}`);
  }

  if (!code || !state) {
    throw new AppError(400, 'MISSING_PARAMS', 'Faltan parámetros OAuth');
  }

  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString()) as { nonce: string };
    const nonce = stateData.nonce;

    // Verify nonce matches cookie and is in the map (CSRF protection)
    if (!cookieNonce || !nonce || cookieNonce !== nonce) {
      throw new AppError(400, 'INVALID_NONCE', 'Nonce no válido o expirado');
    }

    const nonceData = oauthNonces.get(nonce);
    if (!nonceData || Date.now() > nonceData.expiresAt) {
      oauthNonces.delete(nonce);
      throw new AppError(400, 'EXPIRED_NONCE', 'Nonce expirado');
    }

    const rol = nonceData.rol;
    oauthNonces.delete(nonce); // single-use
    res.clearCookie('oauth_nonce', { path: '/' });

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

    setTokenCookie(res, token);
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?code=${ssoCode}`);
  } catch (err: any) {
    const errorCode = err.code || 'SSO_ERROR';
    const errorMsg = err.message || 'Error en autenticación';
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?error=${errorCode}&msg=${encodeURIComponent(errorMsg)}`);
  }
}));

export { router as authRouter };
