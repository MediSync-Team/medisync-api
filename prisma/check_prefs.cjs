const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.paciente.findFirst({
  where: { telefono: { contains: '541170505564' } },
  select: { telefono: true, notifWhatsapp: true, notifRecordatorio24h: true, aceptaRecordatorios: true }
}).then(r => {
  console.log(JSON.stringify(r, null, 2));
  p.$disconnect();
});
