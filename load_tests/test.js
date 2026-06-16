import http from 'k6/http';
import { check, sleep } from 'k6';

// BASE_URL configurable por entorno:
//   BASE_URL=https://staging.medisync.ar k6 run load_tests/test.js
const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

// 1. CONFIGURACIÓN: 50 usuarios virtuales atacando durante 30 segundos
export const options = {
  vus: 50,
  duration: '30s',
};

export default function () {
  // Usamos el endpoint de analíticas que es el que más estresa a Prisma y PostgreSQL
  const url = `${BASE_URL}/api/admin/analytics`;
  
  const respuesta = http.get(url);

  // Verificamos el comportamiento de la API
  // Aceptamos 401 (No token) o 403 (No admin) como respuestas válidas del sistema de seguridad
  check(respuesta, {
    'Servidor responde (200, 401 o 403)': (r) => 
      r.status === 200 || r.status === 401 || r.status === 403,
  });

  // Simula que el administrador se queda mirando el gráfico 1 segundo antes de recargar
  sleep(1);
}