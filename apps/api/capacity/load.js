import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import { retryDelay } from './retry-delay.mjs';

const users = new SharedArray('users', () => JSON.parse(open(__ENV.DATASET)).users);
const banks = new SharedArray('banks', () => JSON.parse(open(__ENV.DATASET)).banks);
const prepared = new SharedArray('prepared', () => __ENV.PREPARED ? JSON.parse(open(__ENV.PREPARED)) : []);
const kind = __ENV.SCENARIO || 'journey';
const n = Number(__ENV.TARGET || 50);
const seconds = Number(__ENV.SECONDS || (kind === 'journey' ? 600 : 180));
const base = __ENV.BASE_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(base)) throw new Error('A local private tunnel is required');
const burst = kind.startsWith('burst_');
export const options = {
  scenarios: { load: kind === 'journey'
    ? { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '60s', target: n }, { duration: seconds + 's', target: n }], gracefulRampDown: '20s', gracefulStop: '20s' }
    : burst ? { executor: 'per-vu-iterations', vus: n, iterations: 1, maxDuration: '45s', gracefulStop: '10s' }
      : { executor: 'constant-arrival-rate', rate: n, timeUnit: '1s', duration: seconds + 's', preAllocatedVUs: Math.min(users.length, Math.max(10, n * 3)), maxVUs: users.length, gracefulStop: '20s' } },
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response', 'error_code'],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: true,
};
const operations = new Counter('business_operations');
const failures = new Counter('business_failures');
const businessOk = new Rate('business_success');
const businessLatency = new Trend('business_latency', true);
const limited = new Counter('responses_429');
const serverErrors = new Counter('responses_5xx');
const transportErrors = new Counter('transport_errors');
const accepted = new Counter('accepted_commands');
const committed = new Counter('committed_commands');
const compressed = new Counter('compressed_responses');
const commitLatency = new Trend('command_commit_latency', true);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }
function event(type, value) { console.log(JSON.stringify({ event: type, ...value })); }
function name(path) { return path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id').split('?')[0]; }
async function call(user, method, path, body, key) {
  const headers = { Authorization: 'Bearer ' + user.token, Accept: 'application/json', 'Accept-Encoding': 'gzip' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await http.asyncRequest(method, base + path, body === undefined ? null : JSON.stringify(body), { headers, responseType: 'text', timeout: '10s', tags: { name: method + ' ' + name(path) } });
  if (response.status === 429) limited.add(1);
  if (response.status >= 500) serverErrors.add(1);
  if (!response.status) { transportErrors.add(1); event('transport_error', { route: method + ' ' + name(path), code: response.error_code, error: response.error }); }
  if (String(response.headers['Content-Encoding'] || '').includes('gzip')) compressed.add(1);
  let data; try { data = response.json(); } catch (_) { data = null; }
  return { status: response.status, data, headers: response.headers };
}
async function reliable(user, method, path, body, key) {
  let failures = 0;
  while (true) {
    const result = await call(user, method, path, body, key);
    if (kind !== 'journey' || result.status && result.status !== 429 && result.status < 500) return result;
    await wait(retryDelay(++failures, result.headers['Retry-After']));
  }
}
function requireOk(response) {
  if (response.status < 200 || response.status >= 300 || !response.data) throw new Error('HTTP_' + response.status + '_' + (response.data && response.data.code || 'unavailable'));
  return response.data;
}
function answer(item) {
  const q = item.question;
  if (q.type === 'SINGLE_CHOICE') return { optionKeys: ['A'] };
  if (q.type === 'MULTIPLE_CHOICE') return { optionKeys: ['A', 'B'] };
  if (q.type === 'TRUE_FALSE') return { value: true };
  if (q.type === 'FILL_BLANK') return { blanks: Array(q.blankCount).fill('容量测试') };
  return { text: '容量测试参考答案' };
}
function item(x) { return { itemId: x.itemId, revisionId: x.question.revisionId, materialRevisionId: x.question.material && x.question.material.revisionId || null, answer: answer(x), confirmed: true, outcome: x.question.type === 'SHORT_ANSWER' ? 'SELF_RATED' : 'CORRECT' }; }
function items(session) { return session.items.map(item); }
function localResult(session) { const short = session.items.filter(i => i.question.type === 'SHORT_ANSWER').length, count = session.items.length - short; return { totalCount: session.items.length, answeredCount: session.items.length, objective: { count, answered: count, correct: count, wrong: 0, unanswered: 0, accuracy: count ? 1 : null, score: count ? 100 : null }, shortAnswer: { count: short, answered: short, rated: 0, correct: 0, wrong: 0, unrated: short } }; }
async function create(user, bank) {
  const key = uuid();
  return requireOk(await reliable(user, 'POST', '/practice/sessions', { scope: bank.scope, expectedContentVersion: bank.preview.contentVersion, expectedContentVersions: bank.preview.contentVersions, deviceId: user.deviceId, }, key));
}
async function persist(user, state, changes, duration) {
  if (!state.pending) {
    state.pending = { key: uuid(), start: Date.now(), accepted: false, body: { expectedVersion: state.session.version, writerToken: state.session.writer.writerToken, clientSequence: ++state.sequence, currentIndex: Math.min(state.session.items.length - 1, changes.length - 1), durationSeconds: duration, items: changes } };
    event('intent', { id: state.pending.key, session: state.session.id, userIndex: exec.vu.idInTest - 1, body: state.pending.body });
  }
  const p = state.pending, path = '/practice/sessions/' + state.session.id + '/sync-commands';
  let polls = 0;
  while (true) {
    const r = await call(user, p.accepted ? 'GET' : 'POST', path + (p.accepted ? '/' + p.key : ''), p.accepted ? undefined : p.body, p.accepted ? undefined : p.key);
    if (r.status === 429 || r.status >= 500 || !r.status) {
      p.failures = (p.failures || 0) + 1;
      await wait(retryDelay(p.failures, r.headers['Retry-After'] || (r.data && r.data.details && r.data.details.retryAfterSeconds)));
      continue;
    }
    const value = requireOk(r);
    p.failures = 0;
    if (!p.accepted) { accepted.add(1); event('accepted', { id: p.key, session: state.session.id, sequence: p.body.clientSequence, items: p.body.items }); p.accepted = true; }
    if (value.state === 'COMMITTED') {
      if (value.acknowledgement.acknowledgedSequence !== p.body.clientSequence) throw new Error('SEQUENCE_MISMATCH');
      state.session.version = value.acknowledgement.version; state.pending = null;
      committed.add(1); commitLatency.add(Date.now() - p.start); return true;
    }
    if (value.state === 'REJECTED' || value.state === 'DEAD_LETTER') throw new Error('COMMAND_' + value.state);
    await wait([1000, 2000, 4000, 8000, 15000, 30000][Math.min(polls++, 5)] * (1 + Math.random() * 0.25));
  }
}
async function finish(user, session, progress, duration, sequence = 1) {
  const key = uuid(), path = '/practice/sessions/' + session.id + '/sync-commands';
  const body = { submittedAt: new Date().toISOString(), clientResult: localResult(session), kind: 'FINISH', expectedVersion: session.version, writerToken: session.writer.writerToken, clientSequence: sequence, currentIndex: session.items.length - 1, durationSeconds: duration, items: progress };
  event('intent', { id: key, session: session.id, userIndex: exec.vu.idInTest - 1, body });
  let known = false, attempts = 0;
  while (true) {
    const response = await call(user, known ? 'GET' : 'POST', path + (known ? '/' + key : ''), known ? undefined : body, known ? undefined : key);
    if (!response.status || response.status === 429 || response.status >= 500) { await wait(retryDelay(++attempts, response.headers['Retry-After'])); continue; }
    const state = requireOk(response);
    if (!known) { known = true; accepted.add(1); event('accepted', { id: key, session: session.id, sequence, items: progress }); }
    if (state.state === 'COMMITTED') {
      const result = requireOk(await reliable(user, 'GET', '/practice/sessions/' + session.id + '/result'));
      if (result.id !== state.resultId) throw new Error('RESULT_REFERENCE_MISMATCH');
      if (result.answeredCount !== progress.length || result.objective.wrong !== 0) throw new Error('RESULT_MISMATCH');
      committed.add(1); event('finished', { session: session.id, result: result.id }); return result;
    }
    if (['REJECTED', 'DEAD_LETTER'].includes(state.state)) throw new Error('COMMAND_' + state.state);
    await wait([1000, 2000, 4000, 8000, 15000, 30000][Math.min(attempts++, 5)] * (1 + Math.random() * 0.25));
  }
}

let writeState;
async function journey(user, bank) {
  requireOk(await reliable(user, 'GET', '/question-banks?includeProgress=true&pageSize=20'));
  const preview = requireOk(await reliable(user, 'POST', '/practice/scope-preview', bank.scope));
  const session = await create(user, { ...bank, preview }), state = { session, sequence: 0, pending: null };
  let done = false, dirty = [], backgroundError;
  const begun = Date.now();
  requireOk(await call(user, 'POST', '/me/activity/heartbeat'));
  const heart = setInterval(() => { call(user, 'POST', '/me/activity/heartbeat').catch(() => {}); }, 60000);
  const background = (async () => {
    while (!done) {
      await wait(1000);
      if (done) break;
      if (dirty.length && Date.now() >= state.readyAt) {
        const batch = dirty; dirty = [];
        try { if (!await persist(user, state, batch, Math.floor((Date.now() - begun) / 1000))) throw new Error('COMMIT_TIMEOUT'); }
        catch (error) { backgroundError = error; break; }
      }
    }
  })();
  const progress = [];
  try {
    for (const item of session.items) {
      await wait(5000 + Math.random() * 10000);
      if (backgroundError) throw backgroundError;
      const changed = { itemId: item.itemId, revisionId: item.question.revisionId, materialRevisionId: item.question.material && item.question.material.revisionId || null, answer: answer(item), confirmed: true, outcome: item.question.type === 'SHORT_ANSWER' ? 'SELF_RATED' : 'CORRECT' };
      progress.push(changed);
      if (!dirty.length) state.readyAt = Date.now() + Number(__ENV.SAVE_INTERVAL_MS || 60000) + Math.random() * 10000;
      dirty.push(changed);
    }
    done = true; await background;
    if (backgroundError) throw backgroundError;
    await finish(user, session, progress, Math.floor((Date.now() - begun) / 1000), state.sequence + 1);
    requireOk(await call(user, 'GET', '/practice/sessions/' + session.id + '/result'));
  } finally { done = true; clearInterval(heart); await background; }
}
export default async function () {
  const index = exec.vu.idInTest - 1;
  if (index >= users.length) exec.test.abort('Unique user pool exhausted');
  const user = users[index], bank = banks[index % banks.length];
  const start = Date.now(); let ok = false;
  try {
    if (burst) {
      await wait(Math.max(0, Number(__ENV.START_AT) - Date.now()) + Math.floor(index * 1000 / n));
      event('burst_start', { index, time: Date.now() });
    }
    if (kind === 'journey') await journey(user, bank);
    else if (kind === 'read') requireOk(await reliable(user, 'GET', '/question-banks?includeProgress=true&pageSize=20'));
    else if (kind === 'create' || kind === 'burst_create') await create(user, bank);
    else if (kind === 'sync') {
      if (!writeState) writeState = { session: await create(user, bank), sequence: 0, pending: null, started: Date.now() };
      if (!await persist(user, writeState, items(writeState.session).map(x => ({ ...x, marked: writeState.sequence % 2 === 0 })), Math.floor((Date.now() - writeState.started) / 1000))) throw new Error('COMMIT_TIMEOUT');
    } else if (kind === 'finish') {
      const session = await create(user, bank); await finish(user, session, items(session), 0);
    } else if (kind === 'burst_finish') {
      const session = prepared[index]; if (!session) throw new Error('Prepared session missing');
      await finish(user, session, items(session), 0);
    } else throw new Error('Unknown scenario');
    ok = true;
  } catch (error) {
    failures.add(1); event('business_error', { code: String(error.message).slice(0, 100) });
  } finally {
    operations.add(1); businessOk.add(ok); businessLatency.add(Date.now() - start);
    if (!ok && kind === 'journey') await wait(1000);
  }
}
