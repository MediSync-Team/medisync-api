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

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }

    const perfil = user.profesional || user.paciente;
    const token = generateToken({ userId: user.id, email: user.email, rol: user.rol });

    res.json(success({ token, user: { id: user.id, email: user.email, rol: user.rol, perfil } }));
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

export { router as authRouter };
