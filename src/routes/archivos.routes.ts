import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const storage = multer.diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  },
});

async function assertTurnoArchivoAccess(turnoId: string, req: AuthRequest) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente: { select: { usuarioId: true } },
      profesional: { select: { usuarioId: true } },
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const userId = req.user!.userId;
  const hasAccess = turno.paciente?.usuarioId === userId || turno.profesional.usuarioId === userId;

  if (!hasAccess) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para acceder a este archivo');
  }
}

router.post(
  '/:turnoId',
  authMiddleware(),
  upload.single('archivo'),
  asyncHandler(async (req: AuthRequest, res) => {
    await assertTurnoArchivoAccess(req.params.turnoId, req);

    if (!req.file) {
      throw new AppError(400, 'NO_FILE', 'No se subió ningún archivo');
    }

    const { turnoId } = req.params;
    const { tipo = 'OTRO' } = req.body;

    const archivo = await prisma.archivo.create({
      data: {
        turnoId,
        tipo: tipo.toUpperCase(),
        url: `/uploads/${req.file.filename}`,
        nombreOriginal: req.file.originalname,
        tamanoBytes: req.file.size,
        mimeType: req.file.mimetype,
      },
    });

    res.status(201).json(success(archivo));
  })
);

router.get('/turno/:turnoId', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  await assertTurnoArchivoAccess(req.params.turnoId, req);

  const archivos = await prisma.archivo.findMany({
    where: { turnoId: req.params.turnoId },
    orderBy: { createdAt: 'desc' },
  });

  res.json(success(archivos));
}));

router.delete('/:id', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const archivo = await prisma.archivo.findUnique({
    where: { id: req.params.id },
    include: { turno: { include: { paciente: true, profesional: true } } },
  });

  if (!archivo) {
    throw new AppError(404, 'NOT_FOUND', 'Archivo no encontrado');
  }

  const userId = req.user!.userId;
  const canDelete = archivo.turno.paciente?.usuarioId === userId || archivo.turno.profesional.usuarioId === userId;
  if (!canDelete) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para eliminar este archivo');
  }

  await prisma.archivo.delete({ where: { id: req.params.id } });
  const uploadPath = path.join(process.cwd(), archivo.url.replace(/^\//, ''));
  await fs.unlink(uploadPath).catch(() => null);

  res.json(success({ deleted: true }));
}));

export { router as archivosRouter };
