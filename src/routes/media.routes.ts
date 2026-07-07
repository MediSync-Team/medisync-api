import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getFileTypeFromBuffer } from '../utils/file-type-validator';
import { storeImage } from '../services/storage.service';

const router = Router();

// In-memory upload; storage.service decides where the bytes land
// (Cloudinary when configured, local ./uploads otherwise).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB is plenty for a profile photo
});

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Upload a profile/avatar image and get back a URL to store in `fotoUrl`.
 * Decoupled from any profile update so patients, professionals and clinics can
 * all reuse it; the caller persists the returned URL via its own updatePerfil.
 * Existing `fotoUrl` values (externally-hosted URLs) keep working untouched —
 * this only produces a new URL when the user actually uploads a file.
 */
router.post(
  '/imagen',
  authMiddleware(),
  upload.single('archivo'),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.file) {
      throw new AppError(400, 'NO_FILE', 'No se subió ninguna imagen');
    }

    // Validate the real image type from the buffer's magic bytes (not client MIME).
    const fileType = await getFileTypeFromBuffer(req.file.buffer);
    if (!fileType || !ALLOWED_IMAGE_MIME.has(fileType.mime)) {
      throw new AppError(400, 'FILE_TYPE_NOT_ALLOWED', 'Solo se permiten imágenes JPG, PNG, GIF o WEBP');
    }

    const stored = await storeImage(req.file.buffer, {
      folder: 'avatars',
      ext: `.${fileType.ext}`,
    });

    // Local-disk URLs are relative to the API host; make them absolute so the web
    // (served from a different origin) can render them directly in an <img>.
    // Cloudinary URLs are already absolute https.
    const url = stored.url.startsWith('/uploads')
      ? `${req.protocol}://${req.get('host')}${stored.url}`
      : stored.url;

    res.status(201).json(success({ url }));
  })
);

export { router as mediaRouter };
