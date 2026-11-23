// Prueba HTTP del criterio de aceptación de B6. No forma parte de los seeds ni
// se ejecuta automáticamente. Apuntar solo a un entorno de pruebas con 5 000
// talleres sintéticos cargados mediante NODE_ENV=test.
//
// Ejemplo de ejecución manual posterior:
// k6 run -e API_BASE_URL=https://<host-de-pruebas>/api/v1 b6-workshop-search.k6.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const invalidResponses = new Counter('workshop_search_invalid_responses');
const baseUrl = __ENV.API_BASE_URL;
if (!baseUrl) {
  throw new Error('Define API_BASE_URL apuntando al prefijo /api/v1 del entorno de pruebas.');
}

export const options = {
  scenarios: {
    workshop_search_5km: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    workshop_search_invalid_responses: ['count==0'],
  },
};

export default function () {
  const url = `${baseUrl.replace(/\/$/, '')}/workshops/search?lat=12.136&lng=-86.250&radius_meters=5000&limit=50`;
  const response = http.get(url, { tags: { endpoint: 'workshops_search_5km' } });
  let payload;
  try {
    payload = response.json();
  } catch (_) {
    payload = null;
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const sortedByDistance = items.every((item, index) =>
    index === 0 || Number(items[index - 1].distance_meters) <= Number(item.distance_meters),
  );
  const valid = check(response, {
    'HTTP 200': (r) => r.status === 200,
    'máximo 50 resultados': () => items.length <= 50,
    'resultados ordenados por distancia': () => sortedByDistance,
    'metadatos de caché offline presentes': () =>
      Number.isInteger(payload?.cache_ttl_seconds) &&
      payload?.max_cache_records === 50 &&
      typeof payload?.fetched_at === 'string',
  });
  if (!valid) invalidResponses.add(1);
  sleep(0.2);
}
