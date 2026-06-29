import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getFileTypeFromBuffer } from '../utils/file-type-validator';
import { storeArchivo, deleteArchivoByUrl } from '../services/storage.service';

const router = Router();

// Keep the upload in memory; storage.service decides where the bytes land
// (Cloudinary when configured, local ./uploads otherwise).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Allowed MIME types based on actual file content (magic bytes)
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
]);

// Map file extensions to expected MIME types for additional validation
const EXPECTED_MIME_BY_EXT: Record<string, string[]> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.pdf': ['application/pdf'],
};

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

    // Validate the real file type from the buffer's magic bytes (not the client MIME).
    const fileType = await getFileTypeFromBuffer(req.file.buffer);
    if (!fileType) {
      throw new AppError(400, 'INVALID_FILE_TYPE', 'No se pudo identificar el tipo de archivo');
    }
    if (!ALLOWED_MIME_TYPES.has(fileType.mime)) {
      throw new AppError(400, 'FILE_TYPE_NOT_ALLOWED', `Tipo de archivo no permitido: ${fileType.mime}`);
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const expectedMimes = EXPECTED_MIME_BY_EXT[ext];
    if (ext && expectedMimes && !expectedMimes.includes(fileType.mime)) {
      throw new AppError(400, 'FILE_EXTENSION_MISMATCH', 'La extensión del archivo no coincide con su contenido');
    }

    const { turnoId } = req.params;
    const { tipo = 'OTRO' } = req.body;

    // Durable storage (Cloudinary) or local-disk fallback — the URL goes into Archivo.url.
    const stored = await storeArchivo(req.file.buffer, {
      turnoId,
      ext: ext || `.${fileType.ext}`,
      mime: fileType.mime,
    });

    const archivo = await prisma.archivo.create({
      data: {
        turnoId,
        tipo: tipo.toUpperCase(),
        url: stored.url,
        nombreOriginal: req.file.originalname,
        tamanoBytes: req.file.size,
        mimeType: fileType.mime, // Use detected MIME type, not client-provided
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
  await deleteArchivoByUrl(archivo.url); // Cloudinary or local, best-effort

  res.json(success({ deleted: true }));
}));

export { router as archivosRouter };
