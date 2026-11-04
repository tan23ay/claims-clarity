import { digest } from './database.mjs';
import { RISK_LEVELS } from './claims-engine.mjs';

export const questionCatalogVersion = 'claims-risk-shadow-v1';
export const questions = {
  risk_advisory: {
    type: 'choice',
    instructions: 'Classify the review risk in this synthetic administrative claim state. This is an advisory judgment, never a coverage decision or authorization.',
    criteria: { LOW: 'Routine, supported administrative explanation.', MEDIUM: 'Pending or incomplete evidence that may need clarification.', HIGH: 'High-risk category, contradiction, or strong signal requiring human review.' },
  },
  should_escalate: {
    type: 'noul',
    instructions: 'Does this synthetic claim state require a human review before a definitive explanation?',
    criteria: { true: 'Risk, insufficient evidence, or a contradiction requires review.', false: 'The stored evidence supports an administrative explanation.' },
  },
};

export function minimizedState(claim, investigation) {
  // Enumerated facts only: no identifiers, names, dates, quotes, or caller text.
  const categories = ['Prior authorization', 'Coverage exclusion', 'Documentation', 'Eligibility', 'Coding discrepancy', 'Duplicate claim', 'Timely filing', 'Partial payment', 'Pending review', 'Coordination of benefits'];
  return {
    outcome: ['Denied', 'Partially paid', 'Pending'].includes(claim.outcome) ? claim.outcome : 'unknown',
    reason_category: categories.includes(claim.reasonCategory) ? claim.reasonCategory : 'unknown',
    risk_floor: investigation.routing.riskFloor,
    reason_status: investigation.packet.reasonStatus,
    policy_support: investigation.packet.policySupport,
    payment_arithmetic_matches: investigation.packet.payment.arithmeticMatches,
    provenance: 'SYNTHETIC',
  };
}

function exactKeys(object, expected) {
  return object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join('|') === [...expected].sort().join('|');
}
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validateJevResponse(result, expectedModel) {
  if (!exactKeys(result, ['model', 'answers', 'usage']) || result.model !== expectedModel || !exactKeys(result.answers, ['risk_advisory', 'should_escalate'])) throw new Error('invalid_contract');
  const risk = result.answers.risk_advisory, escalation = result.answers.should_escalate;
  if (!exactKeys(risk, ['type', 'choice', 'probabilities', 'confidence']) || risk.type !== 'choice' || !RISK_LEVELS.includes(risk.choice) || !probability(risk.confidence) || !exactKeys(risk.probabilities, RISK_LEVELS)) throw new Error('invalid_contract');
  const values = Object.values(risk.probabilities);
  if (!values.every(probability) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.001 || risk.probabilities[risk.choice] < Math.max(...values)) throw new Error('invalid_contract');
  if (!exactKeys(escalation, ['type', 'noul']) || escalation.type !== 'noul' || !probability(escalation.noul)) throw new Error('invalid_contract');
  if (!exactKeys(result.usage, ['input_tokens', 'output_tokens']) || Object.values(result.usage).some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error('invalid_contract');
  return result;
}

export function composeShadow(investigation, result, config) {
  const risk = result.answers.risk_advisory;
  const sorted = Object.values(risk.probabilities).sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  const accepted = risk.confidence >= config.jevMinConfidence && margin >= config.jevMinMargin;
  const candidateRisk = accepted ? RISK_LEVELS[Math.max(RISK_LEVELS.indexOf(investigation.routing.riskFloor), RISK_LEVELS.indexOf(risk.choice))] : investigation.routing.riskFloor;
  const p = result.answers.should_escalate.noul;
  const escalationAssessment = p >= config.jevEscalationThreshold ? 'review' : p <= 1 - config.jevEscalationThreshold ? 'no-additional-signal' : 'uncertain';
  return {
    status: 'shadow', mode: 'shadow', advisoryOnly: true, model: result.model,
    questionCatalogVersion, answers: result.answers, usage: result.usage,
    assessment: { accepted, margin, escalationProbability: p, escalationAssessment, candidateRisk, candidateEscalation: investigation.routing.escalationRequired || candidateRisk === 'HIGH' || escalationAssessment === 'review' },
    thresholds: { confidence: config.jevMinConfidence, margin: config.jevMinMargin, escalation: config.jevEscalationThreshold },
    // Shadow composition is observable but never changes operational routing.
    finalRouting: investigation.routing,
  };
}

export function createJev(config, fetchImpl = fetch) {
  let failures = 0, openUntil = 0;
  return {
    async evaluate(claim, investigation) {
      const state = minimizedState(claim, investigation);
      const body = JSON.stringify({ model: config.jevModel, state, questions });
      const requestHash = digest(body);
      const fallback = reason => ({ status: 'unavailable', mode: 'shadow', advisoryOnly: true, reason, questionCatalogVersion, requestHash, finalRouting: investigation.routing });
      if (!config.jevEnabled) return fallback('disabled');
      if (claim.provenance !== 'SYNTHETIC') return fallback('egress_blocked');
      if (openUntil > Date.now()) return fallback('circuit_open');
      const started = Date.now();
      try {
        const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${config.jevApiKey}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(config.jevTimeoutMs),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`upstream_${response.status}`); }
        // Bound provider output too; do not log upstream error bodies or credentials.
        const reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 65536) { await reader.cancel(); throw new Error('invalid_contract'); }
          chunks.push(Buffer.from(next.value));
        }
        const result = validateJevResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.jevModel);
        failures = 0; openUntil = 0;
        return { ...composeShadow(investigation, result, config), requestHash, latencyMs: Date.now() - started };
      } catch (error) {
        failures++;
        if (failures >= 3) openUntil = Date.now() + config.jevCircuitCooldownMs;
        const reason = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : /^upstream_\d+$/.test(error.message) ? error.message : error.message === 'invalid_contract' || error instanceof SyntaxError ? 'invalid_contract' : 'provider_unavailable';
        return { ...fallback(reason), latencyMs: Date.now() - started };
      }
    },
  };
}
