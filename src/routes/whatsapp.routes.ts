import { Router } from 'express';
import { asyncHandler, AppError } from '../utils/response';
import {
  buildTwimlMessage,
  handleIncomingWhatsappMessage,
  validateTwilioSignature,
} from '../services/whatsapp.service';

const router = Router();

router.post('/webhook', asyncHandler(async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;
  const signature = req.headers['x-twilio-signature'];

  if (!validateTwilioSignature({
    url,
    body: req.body,
    signature: Array.isArray(signature) ? signature[0] : signature,
  })) {
    throw new AppError(403, 'INVALID_TWILIO_SIGNATURE', 'Firma de Twilio invalida');
  }

  const from = String(req.body.From || '');
  const body = String(req.body.Body || '');

  const message = await handleIncomingWhatsappMessage({ from, body });
  res.type('text/xml').send(buildTwimlMessage(message));
}));

export { router as whatsappRouter };
