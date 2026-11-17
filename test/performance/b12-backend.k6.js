// Load suite for a staging environment. Provision enough due reminders for all
// worker iterations before enabling the reminder_worker scenario.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const base = (__ENV.API_BASE_URL || '').replace(/\/$/, '');
const searchLatency = new Trend('b12_workshop_search_duration', true);
const pullLatency = new Trend('b12_sync_pull_duration', true);
const workerLatency = new Trend('b12_reminder_worker_completion_duration', true);
const required = (key) => {
  if (!__ENV[key]) throw new Error(`Define ${key} for the staging load test.`);
  return __ENV[key];
};
if (!base) throw new Error('Define API_BASE_URL with the /api/v1 prefix.');
const syncHeaders = { Authorization: `Bearer ${required('SYNC_ACCESS_TOKEN')}` };
const adminHeaders = { Authorization: `Bearer ${required('ADMIN_ACCESS_TOKEN')}` };
const deviceId = required('SYNC_DEVICE_ID');
const cursor = required('SYNC_CURSOR');
const pushBody = JSON.parse(required('SYNC_PUSH_BODY_JSON'));
const departmentId = required('DEPARTMENT_ID');

export const options = {
  scenarios: {
    workshop_search: { executor: 'constant-vus', exec: 'workshopSearch', vus: Number(__ENV.SEARCH_VUS || 10), duration: __ENV.DURATION || '60s' },
    ad_server: { executor: 'constant-vus', exec: 'adServer', vus: Number(__ENV.ADS_VUS || 5), duration: __ENV.DURATION || '60s' },
    sync_pull: { executor: 'constant-vus', exec: 'syncPull', vus: Number(__ENV.SYNC_PULL_VUS || 5), duration: __ENV.DURATION || '60s' },
    sync_push: { executor: 'constant-vus', exec: 'syncPush', vus: Number(__ENV.SYNC_PUSH_VUS || 2), duration: __ENV.DURATION || '60s' },
    reminder_worker: { executor: 'constant-vus', exec: 'reminderWorker', vus: 1, duration: __ENV.DURATION || '60s' },
  },
  thresholds: {
    'http_req_duration{endpoint:workshop_search}': ['p(95)<300'],
    'http_req_duration{endpoint:sync_pull}': ['p(95)<500'],
    'b12_workshop_search_duration': ['p(95)<300'],
    'b12_sync_pull_duration': ['p(95)<500'],
    'b12_reminder_worker_completion_duration': ['p(95)<5000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function workshopSearch() {
  const response = http.get(`${base}/workshops/search?lat=12.136&lng=-86.250&radius_meters=5000&limit=50`, { tags: { endpoint: 'workshop_search' } });
  searchLatency.add(response.timings.duration);
  check(response, { 'workshop search 200': (r) => r.status === 200 });
}

export function adServer() {
  const slot = encodeURIComponent(__ENV.AD_SLOT_CODE || 'sponsored_result');
  const response = http.get(`${base}/ads/serve?slot_code=${slot}&department_id=${departmentId}&limit=3`, { tags: { endpoint: 'ad_server' } });
  check(response, { 'ad serve 200': (r) => r.status === 200, 'all ads labeled sponsored': (r) => (r.json('items') || []).every((item) => item.patrocinado === true) });
}

export function syncPull() {
  const response = http.get(`${base}/sync/pull?device_id=${deviceId}&cursor=${encodeURIComponent(cursor)}&limit=50&channel=all`, { headers: syncHeaders, tags: { endpoint: 'sync_pull' } });
  pullLatency.add(response.timings.duration);
  check(response, { 'sync pull 200': (r) => r.status === 200 });
}

export function syncPush() {
  const body = JSON.parse(JSON.stringify(pushBody));
  body.mutations = body.mutations.map((mutation) => ({ ...mutation, mutation_id: makeUuidV7() }));
  const response = http.post(`${base}/sync/push`, JSON.stringify(body), { headers: { ...syncHeaders, 'Content-Type': 'application/json' }, tags: { endpoint: 'sync_push' } });
  check(response, { 'sync push accepted': (r) => r.status === 200 || r.status === 201 });
}

function makeUuidV7() {
  const time = Date.now().toString(16).padStart(12, '0').slice(-12);
  const random = Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(3, 6)}-${random.slice(6, 18)}`;
}

export function reminderWorker() {
  const started = Date.now();
  const dispatch = http.post(`${base}/admin/ops/reminders/dispatch-due`, null, { headers: adminHeaders, tags: { endpoint: 'reminder_dispatch' } });
  const enqueued = dispatch.json('enqueued');
  check(dispatch, { 'test reminder was enqueued': (r) => r.status === 202 && enqueued === 1 });
  if (enqueued !== 1) return;
  let drained = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const state = http.get(`${base}/admin/ops/reminders/queue`, { headers: adminHeaders, tags: { endpoint: 'reminder_queue' } });
    const q = state.json();
    if (state.status === 200 && Number(q.active || 0) === 0 && Number(q.waiting || 0) === 0) { drained = true; break; }
    sleep(0.2);
  }
  check(null, { 'reminder worker drained the queued job': () => drained });
  if (drained) workerLatency.add(Date.now() - started);
}
