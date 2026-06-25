/**
 * One-off backfill: geocode the practice address of every profesional that has
 * a `lugarAtencion` but no coordinates yet. Throttled by the geocoding service.
 *
 * Run: npm run geocode:backfill
 */
import prisma from '../src/lib/prisma';
import { geocodeAddress } from '../src/services/geocoding.service';

async function main() {
  const profs = await prisma.profesional.findMany({
    where: { lugarAtencion: { not: null }, latitud: null },
    select: { id: true, lugarAtencion: true },
  });

  console.log(`Geocoding ${profs.length} profesionales sin coordenadas...`);
  let ok = 0;
  let fail = 0;

  for (const p of profs) {
    const point = await geocodeAddress(p.lugarAtencion);
    await prisma.profesional.update({
      where: { id: p.id },
      data: point
        ? { latitud: point.lat, longitud: point.lng, geocodedAt: new Date() }
        : { geocodedAt: new Date() },
    });
    if (point) {
      ok++;
      console.log(`✓ ${p.lugarAtencion} → ${point.lat}, ${point.lng}`);
    } else {
      fail++;
      console.log(`✗ ${p.lugarAtencion} (sin resultado)`);
    }
  }

  console.log(`Listo. ${ok} geocodificados, ${fail} sin resultado.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
