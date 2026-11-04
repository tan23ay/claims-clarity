import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investigateClaim } from '../backend/claims-engine.mjs';
import { digest } from '../backend/database.mjs';
import { composeShadow, createJev, minimizedState, validateJevResponse } from '../backend/jev.mjs';
import { loadConfig } from '../backend/config.mjs';

const claims = JSON.parse(readFileSync(new URL('../data/claims.json', import.meta.url)));
const claim = claims[0];
const baseline = investigateClaim(claim, { ...claim.policy, plan: claim.plan, planVersion: claim.planVersion, contentHash: digest(claim.policy.quote) });
const config = loadConfig({ APP_ENV: 'test', JEV_ENABLED: 'true', JEV_API_KEY: 'typesafe-test-credential' });
const result = (choice = 'LOW', probabilities = { LOW: 0.95, MEDIUM: 0.04, HIGH: 0.01 }, confidence = 0.9, noul = 0.1) => ({ model: 'jev-1.13.0', answers: { risk_advisory: { type: 'choice', choice, probabilities, confidence }, should_escalate: { type: 'noul', noul } }, usage: { input_tokens: 100, output_tokens: 0 } });

test('JEV receives only enumerated synthetic facts, without identifiers, dates, or raw text', async () => {
  let sent;
  const adapter = createJev(config, async (url, request) => { assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); sent = JSON.parse(request.body); return Response.json(result()); });
  const advisory = await adapter.evaluate(claim, baseline);
  assert.equal(advisory.status, 'shadow');
  const serialized = JSON.stringify(sent.state);
  for (const value of [claim.id, claim.memberName, claim.memberId, claim.serviceDate, claim.policy.quote]) assert.ok(!serialized.includes(value));
  assert.deepEqual(sent.state, minimizedState(claim, baseline));
  assert.equal(sent.model, 'jev-1.13.0');
});

test('probability nuance is preserved and shadow output cannot lower the operational floor', () => {
  const composed = composeShadow(baseline, validateJevResponse(result(), config.jevModel), config);
  assert.deepEqual(composed.answers.risk_advisory.probabilities, { LOW: 0.95, MEDIUM: 0.04, HIGH: 0.01 });
  assert.equal(composed.assessment.escalationProbability, 0.1);
  assert.equal(composed.assessment.candidateRisk, 'HIGH');
  assert.equal(composed.finalRouting.finalRisk, 'HIGH');
  assert.equal(composed.finalRouting.escalationRequired, true);
});

test('shadow results can suggest a higher candidate risk without changing live routing', () => {
  const low = { ...baseline, routing: { ...baseline.routing, riskFloor: 'LOW', finalRisk: 'LOW', escalationRequired: false } };
  const composed = composeShadow(low, result('HIGH', { LOW: 0.01, MEDIUM: 0.04, HIGH: 0.95 }, 0.9, 0.95), config);
  assert.equal(composed.assessment.candidateRisk, 'HIGH'); assert.equal(composed.assessment.candidateEscalation, true);
  assert.equal(composed.finalRouting.finalRisk, 'LOW'); assert.equal(composed.finalRouting.escalationRequired, false);
});

test('low confidence, small margins and middling Noul values retain the baseline and flag uncertainty', () => {
  const composed = composeShadow(baseline, result('HIGH', { LOW: 0.3, MEDIUM: 0.3, HIGH: 0.4 }, 0.2, 0.55), config);
  assert.equal(composed.assessment.accepted, false); assert.equal(composed.assessment.escalationAssessment, 'uncertain');
  assert.equal(composed.finalRouting.finalRisk, 'HIGH');
});

test('contract validation rejects unknown classes, missing probabilities, wrong models, and malformed usage', () => {
  const bad = [
    { ...result(), model: 'jev-latest' }, { ...result(), extra: 'unexpected' },
    result('APPROVE'), result('LOW', { LOW: 0.1, MEDIUM: 0.1, HIGH: 0.1 }), result('LOW', { LOW: -1, MEDIUM: 1, HIGH: 1 }),
    result('LOW', { LOW: 0.5 }, 0.9), result('LOW', undefined, 0.9, 1.1),
    { ...result(), usage: { input_tokens: -1, output_tokens: 0 } },
  ];
  for (const value of bad) assert.throws(() => validateJevResponse(value, config.jevModel), /invalid_contract/);
});

test('upstream failures open a bounded circuit breaker; fallback keeps the same deterministic route', async () => {
  let calls = 0;
  const adapter = createJev(config, async () => { calls++; return new Response('unavailable', { status: 529 }); });
  for (let i = 0; i < 3; i++) { const value = await adapter.evaluate(claim, baseline); assert.equal(value.reason, 'upstream_529'); assert.equal(value.finalRouting.finalRisk, 'HIGH'); }
  assert.equal((await adapter.evaluate(claim, baseline)).reason, 'circuit_open'); assert.equal(calls, 3);
});

test('timeout, malformed provider JSON and non-synthetic records return explicit fallback', async () => {
  const timeout = createJev({ ...config, jevTimeoutMs: 100 }, (_url, request) => new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); setTimeout(() => reject(new Error('unexpected delay')), 150).unref(); }));
  const timer = setTimeout(() => {}, 200);
  assert.equal((await timeout.evaluate(claim, baseline)).reason, 'timeout'); clearTimeout(timer);
  const invalid = createJev(config, async () => new Response('{bad-json'));
  assert.equal((await invalid.evaluate(claim, baseline)).reason, 'invalid_contract');
  assert.equal((await invalid.evaluate({ ...claim, provenance: 'REAL' }, baseline)).reason, 'egress_blocked');
});

test('wrong-plan, wrong-version and changed policy passages fail structural citation checks', () => {
  const supported = claims.find(c => c.policySupport === 'SUPPORTED' && c.outcome !== 'Pending');
  const policy = { ...supported.policy, plan: supported.plan, planVersion: supported.planVersion, contentHash: digest(supported.policy.quote) };
  assert.equal(investigateClaim(supported, policy).packet.policySupport, 'ESTABLISHED');
  for (const override of [{ plan: 'Wrong plan' }, { planVersion: '1900.01' }, { effectiveDate: '2099-01-01' }, { quote: 'Injected replacement passage' }]) {
    const value = investigateClaim(supported, { ...policy, ...override });
    assert.equal(value.packet.policySupport, 'NOT_ESTABLISHED'); assert.equal(value.routing.escalationRequired, true); assert.deepEqual(value.packet.citations, []);
  }
});
