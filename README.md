# medisync-api
Backend API - MediSync

## Stack
- Node.js + Express + TypeScript
- Prisma ORM
- PostgreSQL
- JWT + bcrypt

## Setup

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar .env
cp .env.example .env

# 3. Generar cliente Prisma
npx prisma generate

# 4. Crear tablas en DB
npx prisma db push

# 5. Correr seed (datos iniciales)
npm run seed

# 6. Iniciar dev server
npm run dev
```

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Dev server en localhost:4000 |
| `npm run build` | Compilar TypeScript |
| `npm start` | Producción |
| `npx prisma studio` | GUI de la DB |
| `npm run seed` | Poblar DB con datos de prueba |

## Variables de Entorno

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/medisync
JWT_SECRET=tu-secret-muy-largo-y-seguro
PORT=4000
NODE_ENV=development
CLOUDINARY_URL=cloudinary://...
MP_ACCESS_TOKEN=...
MP_WEBHOOK_SECRET=...
FRONTEND_URL=http://localhost:3000
```
