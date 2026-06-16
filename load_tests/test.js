import http from 'k6/http';
import { check, sleep } from 'k6';

// ── Configuración por entorno ────────────────────────────────────────────────
//   BASE_URL    objetivo de la prueba (default: API local)
//   AUTH_TOKEN  bearer token opcional para endpoints autenticados
//
//   BASE_URL=https://staging.medisync.ar AUTH_TOKEN=eyJ... k6 run load_tests/test.js
const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

// ── Perfil de carga + objetivos de rendimiento ───────────────────────────────
// 50 usuarios virtuales durante 30s. La corrida FALLA si no se cumplen:
//   - http_req_failed   < 1%    (tasa de error)
//   - http_req_duration p95 < 500ms (latencia)
export const options = {
  vus: 50,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const params = {
  headers: {
    'Content-Type': 'application/json',
    ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
  },
};

export default function () {
  // Endpoint de analíticas: el que más estresa a Prisma y PostgreSQL.
  // Requiere un AUTH_TOKEN de admin para devolver 200 y cumplir los thresholds.
  const res = http.get(`${BASE_URL}/api/admin/analytics`, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has body': (r) => r.body !== null && r.body.length > 0,
  });

  // El admin observa el gráfico ~1s antes de recargar.
  sleep(1);
}
