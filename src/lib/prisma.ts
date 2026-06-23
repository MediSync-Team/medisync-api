import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const isDev = process.env.NODE_ENV === 'development';

const prisma = isDev
  ? new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  : new PrismaClient();

if (isDev) {
  // Surface slow queries (>100ms) during development to guide payload/index work.
  (prisma as PrismaClient<{ log: [{ emit: 'event'; level: 'query' }] }>).$on(
    'query',
    (e) => {
      if (e.duration > 100) {
        console.warn(`[prisma] SLOW ${e.duration}ms: ${e.query}`);
      }
    }
  );
}

export default prisma;
