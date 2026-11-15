import { WebSocket } from 'k6/websockets';
import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { setTimeout, setInterval, clearTimeout, clearInterval } from 'k6/timers';
import { Rate, Trend, Counter } from 'k6/metrics';
import { retryDelay } from './retry-delay.mjs';

if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(__ENV.WRITER_URL)) throw new Error('A local isolated tunnel is required');
const users = new SharedArray('isolated-writers', () => JSON.parse(open(__ENV.WRITER_FIXTURE)));
const failures = new Rate('writer_failures'), bound = new Counter('writer_bound');
const heartbeat = new Trend('writer_heartbeat_ms'), notice = new Trend('writer_takeover_notice_ms');
const committed = new Counter('writer_committed'), retries = new Counter('writer_retries');
const takeovers = new Counter('writer_takeovers'), receipt = new Trend('writer_receipt_ms');
const busy = new Counter('writer_server_busy'), backlog = new Counter('writer_backlog_full'), unavailable = new Counter('writer_other_retry');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const options = {
  scenarios: { writers: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '45s', target: Number(__ENV.WRITER_USERS) },
    { duration: '180s', target: Number(__ENV.WRITER_USERS) },
    { duration: '5s', target: 0 }
  ], gracefulRampDown: '0s' } },
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response', 'error_code'],
  thresholds: { writer_failures: ['rate==0'], writer_committed: [`count==${2 * Number(__ENV.WRITER_USERS)}`],
    ...(__ENV.WRITER_MODE === 'sockets' ? { writer_bound: [`count==${Number(__ENV.WRITER_USERS)}`], writer_takeovers: ['count==20'], writer_takeover_notice_ms: ['p(95)<2000'] } : {}) }
};
function key() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.random() * 16 | 0; return (c === 'x' ? n : n & 3 | 8).toString(16); }); }
function fail(stage, result) { failures.add(true); console.log(JSON.stringify({ stage, status: result && result.status, code: result && result.data && (result.data.code || result.data.state) })); }
export default async function () {
  const user = users[__VU - 1], headers = { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' };
  const root = `/api/v1/practice/sessions/${user.practice}`;
  let sequence = 0, version = 1, healthy = true, work = Promise.resolve();
  async function call(method, path, body, idempotency, other = false) {
    const response = await http.asyncRequest(method, __ENV.WRITER_URL + path, body ? JSON.stringify(body) : null,
      { headers: { ...headers, ...(other ? { Authorization: `Bearer ${user.otherToken}` } : {}), ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
        timeout: '10s', tags: { name: method + ' ' + path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id') } });
    let data; try { data = response.json(); } catch (_) {}
    if (!response.status || response.status === 429 || response.status >= 500) {
      retries.add(1); (data && data.code === 'SERVER_BUSY' ? busy : data && data.code === 'SYNC_BACKLOG_FULL' ? backlog : unavailable).add(1);
    }
    return { status: response.status, data, retryAfter: response.headers['Retry-After'] || data && data.details && data.details.retryAfterSeconds };
  }
  async function save() {
    if (!healthy) return;
    const command = key(), path = root + '/sync-commands', began = Date.now(), deadline = began + 120000;
    const body = { expectedVersion: version, writerToken: user.writer, clientSequence: ++sequence, currentIndex: 0, durationSeconds: sequence, items: [], kind: 'SAVE' };
    let accepted = false, attempts = 0, polls = 0, result;
    while (Date.now() < deadline) {
      result = await call(accepted ? 'GET' : 'POST', path + (accepted ? '/' + command : ''), accepted ? null : body, accepted ? null : command);
      if (!result.status || result.status === 429 || result.status >= 500) {
        await wait(Math.max(0, Math.min(deadline - Date.now(), retryDelay(++attempts, result.retryAfter)))); continue;
      }
      if (result.status !== (accepted ? 200 : 202)) break;
      accepted = true; attempts = 0;
      if (result.data.state === 'COMMITTED') {
        version = result.data.acknowledgement.version; committed.add(1); receipt.add(Date.now() - began); failures.add(false); return;
      }
      if (['REJECTED', 'DEAD_LETTER'].includes(result.data.state)) break;
      await wait([1000, 2000, 4000, 8000, 15000, 30000][Math.min(polls++, 5)] * (1 + Math.random() * 0.25));
    }
    healthy = false; fail(accepted ? 'receipt' : 'admission', result);
  }
  if (__ENV.WRITER_MODE === 'baseline') {
    const began = Date.now(); await wait(Math.random() * 30000); await save();
    await wait(Math.max(0, 60000 + Math.random() * 30000 - (Date.now() - began))); await save(); await wait(300000); return;
  }
  let pingAt = 0, takingOver = false, takeoverAt = 0, expectedClose = false, timer;
  const scheduled = [];
  const socket = new WebSocket(`${__ENV.WRITER_URL.replace(/^http/, 'ws')}/api/v1/practice/writer-socket?sessionId=${user.practice}&deviceId=${user.device}`, null, { headers: { ...headers, Origin: 'https://servicewechat.com' } });
  scheduled.push(setTimeout(() => { expectedClose = true; socket.close(); }, Math.max(0, 224000 - exec.instance.currentTestRunDuration)));
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'BIND', writerToken: user.writer, epoch: 1 })));
  socket.addEventListener('message', async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'BOUND') {
      bound.add(1); failures.add(false);
      timer = setInterval(() => { if (socket.readyState === 1) { pingAt = Date.now(); socket.send(JSON.stringify({ type: 'PING' })); } }, 30000);
      scheduled.push(setTimeout(() => { work = work.then(save); }, Math.random() * 30000));
      scheduled.push(setTimeout(() => { work = work.then(save); }, 60000 + Math.random() * 30000));
      if (__VU <= 20) scheduled.push(setTimeout(async () => {
        await work;
        if (!healthy) return;
        takingOver = true; takeoverAt = Date.now();
        const result = await call('POST', root + '/claim-writer', { expectedEpoch: 1, deviceId: user.otherDevice }, key(), true);
        if (result.status !== 200) fail('claim', result);
      }, 120000));
    } else if (message.type === 'PONG') heartbeat.add(Date.now() - pingAt);
    else if (message.type === 'DRAIN_WRITER' && takingOver) {
      notice.add(Date.now() - takeoverAt); await work;
      const result = await call('POST', root + '/release-writer', { expectedVersion: version, writerToken: user.writer }, key());
      if (result.status !== 200) { fail('release', result); return; }
      const state = await call('GET', root + `/writer-state?deviceId=${user.otherDevice}`, null, null, true);
      if (state.status === 200 && state.data.transfer && state.data.transfer.state === 'READY' && state.data.writer.deviceId === user.otherDevice) { takeovers.add(1); failures.add(false); }
      else fail('claimed_state', state);
    } else if (message.type === 'WRITER_CHANGED' && takingOver) { expectedClose = true; }
    else fail('control', { data: { code: message.type } });
  });
  socket.addEventListener('error', () => fail('socket_error'));
  socket.addEventListener('close', event => {
    clearInterval(timer); scheduled.forEach(clearTimeout);
    if (!expectedClose) fail('socket_close', { status: event.code });
  });
  await wait(300000);
}
