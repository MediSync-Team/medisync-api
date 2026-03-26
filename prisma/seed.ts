import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Especialidades
  const especialidades = await Promise.all([
    prisma.especialidad.upsert({
      where: { nombre: 'Clínica Médica' },
      update: {},
      create: { nombre: 'Clínica Médica', descripcion: 'Medicina general', icono: 'stethoscope' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Psicología' },
      update: {},
      create: { nombre: 'Psicología', descripcion: 'Salud mental', icono: 'brain' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Cardiología' },
      update: {},
      create: { nombre: 'Cardiología', descripcion: 'Enfermedades del corazón', icono: 'heart' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Dermatología' },
      update: {},
      create: { nombre: 'Dermatología', descripcion: 'Piel y anexos', icono: 'scan' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Nutrición' },
      update: {},
      create: { nombre: 'Nutrición', descripcion: 'Alimentación y dietética', icono: 'apple' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Traumatología' },
      update: {},
      create: { nombre: 'Traumatología', descripcion: 'Huesos y articulaciones', icono: 'bone' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Pediatría' },
      update: {},
      create: { nombre: 'Pediatría', descripcion: 'Niños y adolescentes', icono: 'baby' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Ginecología' },
      update: {},
      create: { nombre: 'Ginecología', descripcion: 'Salud femenina', icono: 'heart-pulse' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Oftalmología' },
      update: {},
      create: { nombre: 'Oftalmología', descripcion: 'Visión', icono: 'eye' },
    }),
    prisma.especialidad.upsert({
      where: { nombre: 'Psiquiatría' },
      update: {},
      create: { nombre: 'Psiquiatría', descripcion: 'Trastornos mentales', icono: 'brain' },
    }),
  ]);

  console.log(`✅ Created ${especialidades.length} especialidades`);
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
