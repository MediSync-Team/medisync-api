/**
 * Script to promote an existing user to ADMIN role, or create a new admin user.
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/create-admin.ts <email> [password]
 *
 * If password is provided and the user does not exist, creates a new one.
 * If user already exists, just updates their rol to ADMIN.
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import bcrypt from 'bcrypt';

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email) {
    console.error('Usage: npx ts-node src/scripts/create-admin.ts <email> [password]');
    process.exit(1);
  }

  const existing = await prisma.usuario.findUnique({ where: { email } });

  if (existing) {
    await prisma.usuario.update({ where: { email }, data: { rol: 'ADMIN' } });
    console.log(`✅ Usuario "${email}" promovido a ADMIN.`);
  } else {
    if (!password) {
      console.error('El usuario no existe. Proporcioná una contraseña para crearlo.');
      process.exit(1);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.usuario.create({ data: { email, passwordHash, rol: 'ADMIN' } });
    console.log(`✅ Usuario ADMIN "${email}" creado.`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
