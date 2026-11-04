import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../backend/app.mjs';
import { loadConfig } from '../backend/config.mjs';

async function fixture(t, env = {}, fetchImpl) {
  const app = createApplication({ config: loadConfig({ APP_ENV: 'test', DATABASE_PATH: ':memory:', PORT: '0', ...env }), fetchImpl, logger: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, token, cookie, csrf, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const content = await response.text();
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content;
    return { response, status: response.status, data };
  }
  async function demo() {
    const result = await request('/api/auth/demo', { method: 'POST', body: {} });
    assert.equal(result.status, 201);
    return { ...result.data, cookie: result.response.headers.get('set-cookie').split(';')[0] };
  }
  async function call(token, claimId = 'CLM-PA-02600') {
    const created = await request('/api/calls', { method: 'POST', body: {}, token });
    const id = created.data.id;
    assert.equal((await request(`/api/calls/${id}/verify`, { method: 'POST', body: { confirmed: true }, token })).status, 200);
    assert.equal((await request(`/api/calls/${id}/claim`, { method: 'POST', body: { claimId }, token })).status, 200);
    return id;
  }
  return { app, request, demo, call };
}

test('health, UI, and OpenAPI are available; source, secrets and database are not served', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/health')).data.database, 'ok');
  assert.match((await request('/')).data, /Claims Clarity/);
  assert.equal((await request('/api/openapi.json')).data.openapi, '3.1.0');
  for (const path of ['/.env', '/backend/config.mjs', '/server.mjs', '/storage/claims.sqlite', '/.git/config']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/data/claims.json')).status, 401);
  assert.equal((await request('/api/claims')).status, 401);
});

test('claims are authenticated, searchable, filtered, paginated, and always synthetic', async t => {
  const { request, demo } = await fixture(t); const { token } = await demo();
  const all = (await request('/api/claims', { token })).data;
  assert.equal(all.total, 50); assert.equal(all.items.length, 50);
  assert.ok(all.items.every(c => c.provenance === 'SYNTHETIC'));
  assert.equal((await request('/api/claims?q=CLM-PA-02600', { token })).data.total, 1);
  const page = (await request('/api/claims?risk=HIGH&limit=2&offset=1', { token })).data;
  assert.equal(page.items.length, 2); assert.ok(page.items.every(c => c.risk === 'HIGH'));
  for (const query of ['risk=BOGUS', 'limit=999', 'offset=-1', 'escalation=maybe']) assert.equal((await request(`/api/claims?${query}`, { token })).status, 400);
  assert.equal((await request('/api/claims?q=%27%20OR%201%3D1', { token })).data.total, 0);
});

test('the API rejects privilege and claim-payload injection', async t => {
  const { request, demo } = await fixture(t); const { token } = await demo();
  assert.equal((await request('/api/auth/demo', { method: 'POST', body: { role: 'admin' } })).status, 400);
  assert.equal((await request('/api/calls', { method: 'POST', body: { userId: 'other-user' }, token })).status, 400);
  assert.equal((await request('/api/jev/shadow', { method: 'POST', body: { claim: { id: 'CLM-PA-02600', risk: 'LOW' } }, token })).status, 400);
  assert.equal((await request('/api/admin/dataset', { token })).status, 403);
});

test('cookie sessions require CSRF; untrusted origins are blocked', async t => {
  const { request, demo } = await fixture(t); const session = await demo();
  assert.equal((await request('/api/calls', { method: 'POST', body: {}, cookie: session.cookie })).status, 403);
  assert.equal((await request('/api/calls', { method: 'POST', body: {}, cookie: session.cookie, csrf: session.csrfToken })).status, 201);
  assert.equal((await request('/api/auth/demo', { method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request('/api/auth/me', { cookie: session.cookie })).data.csrfToken, session.csrfToken);
});

test('end-to-end: verified caller -> claim -> explanation -> handoff -> completion -> audit', async t => {
  const { app, request, demo, call } = await fixture(t); const { token } = await demo();
  const id = await call(token);
  const explained = await request(`/api/calls/${id}/explanation`, { method: 'POST', body: {}, token });
  assert.equal(explained.status, 200); assert.equal(explained.data.verified, true);
  assert.equal(explained.data.routing.finalRisk, 'HIGH'); assert.equal(explained.data.routing.escalationRequired, true);
  assert.equal(explained.data.jev.reason, 'disabled');
  assert.match(explained.data.text, /human review/);
  const first = await request(`/api/calls/${id}/handoff`, { method: 'POST', body: {}, token });
  const second = await request(`/api/calls/${id}/handoff`, { method: 'POST', body: {}, token });
  assert.equal(first.data.id, second.data.id); assert.equal(first.data.externalActionSent, false);
  assert.equal((await request('/api/handoffs', { token })).data.items.length, 1);
  assert.equal((await request(`/api/calls/${id}/complete`, { method: 'POST', body: {}, token })).data.state, 'COMPLETED');
  const audit = (await request('/api/audit', { token })).data.items;
  assert.equal(audit.filter(e => e.event === 'Human handoff prepared').length, 1);
  assert.equal(app.store.verifyAudit().valid, true);
  assert.throws(() => app.store.db.exec("DELETE FROM audit_events"), /append-only/);
  assert.throws(() => app.store.db.exec("UPDATE audit_events SET result='tampered'"), /append-only/);
});

test('verification cannot be skipped and invalid transitions are rejected', async t => {
  const { request, demo } = await fixture(t); const { token } = await demo();
  const created = await request('/api/calls', { method: 'POST', body: {}, token }); const id = created.data.id;
  assert.equal((await request(`/api/calls/${id}/claim`, { method: 'POST', body: { claimId: 'CLM-PA-02600' }, token })).status, 409);
  assert.equal((await request(`/api/calls/${id}/explanation`, { method: 'POST', body: {}, token })).status, 409);
  assert.equal((await request(`/api/calls/${id}/verify`, { method: 'POST', body: { confirmed: false }, token })).status, 400);
  assert.equal((await request(`/api/calls/${id}/handoff`, { method: 'POST', body: {}, token })).status, 409);
});

test('call ownership isolates users and not-found/unauthorized responses agree', async t => {
  const { request, demo, call } = await fixture(t);
  const a = await demo(), b = await demo(); const id = await call(a.token);
  const forbidden = await request(`/api/calls/${id}`, { token: b.token });
  const missing = await request('/api/calls/missing', { token: b.token });
  assert.equal(forbidden.status, 404); assert.equal(forbidden.data.error.code, missing.data.error.code); assert.equal(forbidden.data.error.message, missing.data.error.message);
  assert.equal((await request(`/api/calls/${id}/explanation`, { method: 'POST', body: {}, token: b.token })).status, 404);
  assert.equal((await request('/api/calls', { token: b.token })).data.items.length, 0);
  assert.ok(!(await request('/api/audit', { token: b.token })).data.items.some(e => e.record === id));
});

test('exact claim references and the per-call lookup cap are enforced', async t => {
  const { request, demo } = await fixture(t, { MAX_CALL_LOOKUPS: '2' }); const { token } = await demo();
  const { data: { id } } = await request('/api/calls', { method: 'POST', body: {}, token });
  await request(`/api/calls/${id}/verify`, { method: 'POST', body: { confirmed: true }, token });
  for (const claimId of ['CLM-PA-0260', 'clm-pa-02600']) assert.equal((await request(`/api/calls/${id}/claim`, { method: 'POST', body: { claimId }, token })).status, 404);
  assert.equal((await request(`/api/calls/${id}/claim`, { method: 'POST', body: { claimId: 'CLM-PA-02600' }, token })).status, 429);
});

test('logout and expiry revoke access; admin login is configured, never hard-coded', async t => {
  const { app, request, demo } = await fixture(t, { DEMO_ADMIN_PASSWORD: 'test-admin-password' });
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  const admin = (await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'test-admin-password' } })).data;
  assert.equal((await request('/api/admin/audit/integrity', { token: admin.token })).data.valid, true);
  const guest = await demo();
  await request('/api/auth/logout', { method: 'POST', body: {}, token: guest.token });
  assert.equal((await request('/api/claims', { token: guest.token })).status, 401);
  app.store.db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await request('/api/claims', { token: admin.token })).status, 401);
});

test('pending records produce a status-only answer, and partial citations are not spoken', async t => {
  const { request, demo, call } = await fixture(t); const { token } = await demo();
  const pending = await call(token, 'CLM-PN-02608');
  const p = (await request(`/api/calls/${pending}/explanation`, { method: 'POST', body: {}, token })).data;
  assert.equal(p.packet.reason, null); assert.deepEqual(p.packet.citations, []); assert.match(p.text, /still in progress/);
  const partial = await call(token, 'CLM-PA-02600');
  const v = (await request(`/api/calls/${partial}/explanation`, { method: 'POST', body: {}, token })).data;
  assert.equal(v.packet.policySupport, 'NOT_ESTABLISHED'); assert.deepEqual(v.packet.citations, []);
  assert.ok(!v.text.includes('Section 4.1')); assert.equal(v.packet.payment.billedCents, 52000);
});

test('SQLite persists calls, sessions, handoffs and audit events across a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-backend-'));
  let second;
  t.after(async () => { if (second) await second.close(); await rm(dir, { recursive: true, force: true }); });
  const config = loadConfig({ APP_ENV: 'test', DATABASE_PATH: join(dir, 'test.sqlite'), PORT: '0' });
  const first = createApplication({ config, logger: () => {} });
  await new Promise(resolve => first.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${first.server.address().port}`;
  const session = await (await fetch(base + '/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const created = await (await fetch(base + '/api/calls', { method: 'POST', headers, body: '{}' })).json();
  await first.close();
  second = createApplication({ config, logger: () => {} });
  await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
  const next = `http://127.0.0.1:${second.server.address().port}`;
  const response = await fetch(next + `/api/calls/${created.id}`, { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'CREATED');
  assert.equal(second.store.claims().total, 50); assert.equal(second.store.verifyAudit().valid, true);
});

test('disabled demo access and unsafe production/key configuration fail closed', async t => {
  const { request } = await fixture(t, { DEMO_MODE: 'false', DEMO_ADMIN_PASSWORD: 'test-admin-password' });
  assert.equal((await request('/api/auth/demo', { method: 'POST', body: {} })).status, 403);
  assert.throws(() => loadConfig({ APP_ENV: 'production' }), /production integrations/);
  assert.throws(() => loadConfig({ JEV_ENABLED: 'true', JEV_API_KEY: 'sk-or-test' }), /TypeSafe-issued/);
  assert.throws(() => loadConfig({ JEV_MODEL: 'jev-latest' }), /exact version/);
  assert.throws(() => loadConfig({ CORS_ORIGINS: '*' }));
});

test('malformed and oversized bodies are rejected without leaking internals', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/auth/demo', { method: 'POST', body: { padding: 'x'.repeat(20_000) } })).status, 413);
});

test('concurrent explanation requests cannot overwrite a call that was cancelled', async t => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const upstream = new Promise(resolve => { release = resolve; });
  const { request, demo, call } = await fixture(t, { JEV_ENABLED: 'true', JEV_API_KEY: 'typesafe-test-credential' }, async () => { markStarted(); return upstream; });
  const { token } = await demo(); const id = await call(token);
  const pending = request(`/api/calls/${id}/explanation`, { method: 'POST', body: {}, token });
  await started;
  assert.equal((await request(`/api/calls/${id}/explanation`, { method: 'POST', body: {}, token })).status, 409);
  assert.equal((await request(`/api/calls/${id}/cancel`, { method: 'POST', body: {}, token })).data.state, 'CANCELLED');
  release(Response.json({ model: 'jev-1.13.0', answers: { risk_advisory: { type: 'choice', choice: 'HIGH', probabilities: { LOW: 0.01, MEDIUM: 0.04, HIGH: 0.95 }, confidence: 0.9 }, should_escalate: { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 1, output_tokens: 0 } }));
  assert.equal((await pending).status, 409);
  assert.equal((await request(`/api/calls/${id}`, { token })).data.state, 'CANCELLED');
});

test('interrupted investigations recover on restart without changing the audit chain', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claims-recovery-'));
  const config = loadConfig({ APP_ENV: 'test', DATABASE_PATH: join(dir, 'test.sqlite'), PORT: '0' });
  const first = createApplication({ config, logger: () => {} });
  first.store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('recovery-user', 'recovery-user', 'demo', null, new Date().toISOString());
  const now = new Date().toISOString();
  first.store.db.prepare('INSERT INTO calls(id,user_id,state,claim_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('interrupted-call', 'recovery-user', 'INVESTIGATING', 'CLM-PA-02600', now, now);
  first.store.close();
  const second = createApplication({ config, logger: () => {} });
  t.after(async () => { second.store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(second.store.db.prepare('SELECT state FROM calls WHERE id=?').get('interrupted-call').state, 'MATCHED');
  assert.equal(second.store.verifyAudit().valid, true);
});
