/**
 * File storage for turno attachments (clinical files + in-call chat files).
 *
 * Uses Cloudinary when CLOUDINARY_URL is configured (durable + CDN, survives
 * Railway redeploys); otherwise falls back to local ./uploads disk (fine for
 * local dev). The resulting URL is stored in Archivo.url — no schema change, and
 * deletion derives the Cloudinary public_id from that URL (no extra column).
 */
import { v2 as cloudinary } from 'cloudinary';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

// Re-reads CLOUDINARY_URL from the environment and forces https delivery URLs.
cloudinary.config({ secure: true });

const UPLOAD_DIR = './uploads';

export function isCloudinaryConfigured(): boolean {
  return Boolean(process.env.CLOUDINARY_URL);
}

export interface StoredFile {
  url: string;
  storage: 'cloudinary' | 'local';
}

/**
 * Persist a validated file buffer and return its URL.
 * Cloudinary path stores under medisync/turnos/<turnoId>/; PDFs go as `raw`.
 */
export async function storeArchivo(
  buffer: Buffer,
  opts: { turnoId: string; ext: string; mime: string },
): Promise<StoredFile> {
  if (isCloudinaryConfigured()) {
    const isPdf = opts.mime === 'application/pdf';
    const resourceType: 'image' | 'raw' = isPdf ? 'raw' : 'image';
    const folder = `medisync/turnos/${opts.turnoId}`;
    // raw (pdf) keeps the extension in its public_id; images get the format appended by Cloudinary.
    const publicId = isPdf ? `${randomUUID()}${opts.ext}` : randomUUID();

    const url = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: resourceType, public_id: publicId },
        (err, result) => {
          if (err || !result) reject(err ?? new Error('Cloudinary upload failed'));
          else resolve(result.secure_url);
        },
      );
      stream.end(buffer);
    });
    return { url, storage: 'cloudinary' };
  }

  // Local-disk fallback (dev without Cloudinary).
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}${opts.ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return { url: `/uploads/${filename}`, storage: 'local' };
}

/** Best-effort deletion by stored URL (Cloudinary public_id derived from the URL, or local file). */
export async function deleteArchivoByUrl(url: string): Promise<void> {
  const parsed = parseCloudinaryUrl(url);
  if (parsed) {
    await cloudinary.uploader
      .destroy(parsed.publicId, { resource_type: parsed.resourceType })
      .catch(() => undefined);
    return;
  }
  // Local file.
  const local = path.join(process.cwd(), url.replace(/^\/+/, ''));
  await fs.unlink(local).catch(() => undefined);
}

function parseCloudinaryUrl(
  url: string,
): { publicId: string; resourceType: 'image' | 'raw' | 'video' } | null {
  if (!/^https?:\/\/res\.cloudinary\.com\//.test(url)) return null;
  // .../<resource_type>/upload/v<version>/<public_id>(.ext)
  const m = url.match(/\/(image|raw|video)\/upload\/(?:v\d+\/)?(.+)$/);
  if (!m) return null;
  const resourceType = m[1] as 'image' | 'raw' | 'video';
  let publicId = m[2];
  if (resourceType !== 'raw') publicId = publicId.replace(/\.[^/.]+$/, ''); // image/video public_id excludes ext
  return { publicId, resourceType };
}
