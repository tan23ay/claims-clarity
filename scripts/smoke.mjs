import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4173';
let token;
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path} returned ${response.status}: ${result.error?.code}`);
  return result;
}
assert.equal((await request('/api/health')).status, 'ok');
const session = await request('/api/auth/demo', 'POST', {});
token = session.token;
const claims = await request('/api/claims?limit=100');
assert.equal(claims.total, 50);
assert.ok(claims.items.every(c => c.provenance === 'SYNTHETIC'));
const call = await request('/api/calls', 'POST', {});
await request(`/api/calls/${call.id}/verify`, 'POST', { confirmed: true });
await request(`/api/calls/${call.id}/claim`, 'POST', { claimId: 'CLM-PA-02600' });
const explanation = await request(`/api/calls/${call.id}/explanation`, 'POST', {});
assert.equal(explanation.verified, true);
assert.equal(explanation.routing.escalationRequired, true);
const first = await request(`/api/calls/${call.id}/handoff`, 'POST', {});
const second = await request(`/api/calls/${call.id}/handoff`, 'POST', {});
assert.equal(first.id, second.id);
await request(`/api/calls/${call.id}/complete`, 'POST', {});
assert.ok((await request('/api/audit')).items.some(e => e.event === 'Human handoff prepared'));
await request('/api/auth/logout', 'POST', {});
console.log('PASS: session -> 50 claims -> verification -> exact match -> explanation -> idempotent handoff -> completion -> persistent audit');
