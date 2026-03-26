import { Router } from 'express';
import { asyncHandler, success } from '../utils/response';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/:turnoId', authMiddleware(), asyncHandler(async (req, res) => {
  // TODO: Implementar upload a Cloudinary
  res.status(201).json(success({ url: 'https://mock-cloudinary.com/archivo.pdf' }));
}));

router.delete('/:id', authMiddleware(), asyncHandler(async (req, res) => {
  // TODO: Implementar delete
  res.json(success({ deleted: true }));
}));

export { router as archivosRouter };
