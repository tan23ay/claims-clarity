import { randomUUID } from 'node:crypto';
import { ApiError, notFound } from './errors.mjs';
import { investigateClaim } from './claims-engine.mjs';

export function createWorkflow(store, config, jev) {
  function getCall(user, id) {
    const row = store.db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!row) throw notFound();
    return row;
  }
  function serialize(row) {
    return { id: row.id, state: row.state, claimId: row.claim_id, verification: row.verification, lookupAttempts: row.lookup_attempts, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, explanation: row.explanation ? JSON.parse(row.explanation) : null, provenance: 'SYNTHETIC' };
  }
  function requireState(user, row, states) {
    if (!states.includes(row.state)) {
      store.audit(user.id, 'Transition rejected', row.id, 'Blocked', { state: row.state });
      throw new ApiError(409, 'INVALID_TRANSITION', `This operation is not allowed in ${row.state}.`);
    }
  }
  function update(user, row, state, fields = {}) {
    const changed = store.db.prepare('UPDATE calls SET state=?, claim_id=?, verification=?, explanation=?, version=version+1, updated_at=? WHERE id=? AND user_id=? AND version=?')
      .run(state, fields.claimId ?? row.claim_id, fields.verification ?? row.verification, fields.explanation ? JSON.stringify(fields.explanation) : row.explanation, new Date().toISOString(), row.id, user.id, row.version);
    if (!changed.changes) throw new ApiError(409, 'CONCURRENT_CHANGE', 'The call changed. Fetch its latest state and try again.');
  }
  async function shadow(user, claim) {
    const investigation = investigateClaim(claim, store.policy(claim.policyId));
    const result = await jev.evaluate(claim, investigation);
    store.db.prepare('INSERT INTO jev_calls VALUES (?,?,?,?,?,?)').run(randomUUID(), user.id, claim.id, result.requestHash, JSON.stringify(result), new Date().toISOString());
    store.audit(user.id, 'JEV shadow evaluated', claim.id, result.status === 'shadow' ? 'Advisory' : 'Fallback', { reason: result.reason || null, model: result.model || null });
    return result;
  }
  return {
    shadow,
    get(user, id) { return serialize(getCall(user, id)); },
    list(user) { return store.db.prepare('SELECT * FROM calls WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id).map(serialize); },
    create(user) {
      const id = randomUUID(), now = new Date().toISOString();
      store.transaction(() => {
        store.db.prepare('INSERT INTO calls(id,user_id,state,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, user.id, 'CREATED', now, now);
        store.audit(user.id, 'Guided call opened', id, 'Started');
      });
      return serialize(getCall(user, id));
    },
    verify(user, id, confirmed) {
      const row = getCall(user, id);
      requireState(user, row, ['CREATED']);
      if (confirmed !== true) throw new ApiError(400, 'VERIFICATION_REQUIRED', 'Confirm the synthetic caller verification first.');
      store.transaction(() => {
        update(user, row, 'VERIFIED', { verification: 'DEMO_CONFIRMED' });
        store.audit(user.id, 'Caller verification', id, 'Verified', { method: 'synthetic-checkbox' });
      });
      return serialize(getCall(user, id));
    },
    match(user, id, claimId) {
      const row = getCall(user, id);
      requireState(user, row, ['VERIFIED']);
      if (row.lookup_attempts >= config.maxLookups) throw new ApiError(429, 'LOOKUP_LIMIT', 'The lookup limit for this call was reached. Start another demo call.');
      store.db.prepare('UPDATE calls SET lookup_attempts=lookup_attempts+1 WHERE id=?').run(id);
      const claim = store.claim(claimId);
      if (!claim) { store.audit(user.id, 'Claim lookup', id, 'No match'); throw notFound(); }
      store.transaction(() => {
        update(user, row, 'MATCHED', { claimId: claim.id });
        store.audit(user.id, 'Exact claim match', claim.id, 'Matched', { callId: id });
      });
      return { call: serialize(getCall(user, id)), claim };
    },
    async explain(user, id) {
      let row = getCall(user, id);
      if (['EXPLAINED', 'ESCALATED', 'COMPLETED'].includes(row.state) && row.explanation) return JSON.parse(row.explanation);
      requireState(user, row, ['MATCHED']);
      update(user, row, 'INVESTIGATING');
      row = getCall(user, id);
      try {
        const claim = store.claim(row.claim_id);
        const baseline = investigateClaim(claim, store.policy(claim.policyId));
        const jevResult = await shadow(user, claim);
        const explanation = { ...baseline, jev: jevResult, provenance: 'SYNTHETIC' };
        store.transaction(() => {
          update(user, row, 'EXPLAINED', { explanation });
          store.audit(user.id, 'Verified explanation prepared', claim.id, baseline.routing.escalationRequired ? 'Escalated' : 'Explained', { callId: id, verificationMode: baseline.verificationMode });
        });
        return explanation;
      } catch (error) {
        const current = getCall(user, id);
        if (current.state === 'INVESTIGATING') update(user, current, 'MATCHED');
        throw error;
      }
    },
    handoff(user, id) {
      const row = getCall(user, id);
      const existing = store.db.prepare('SELECT packet FROM handoffs WHERE call_id=? AND user_id=?').get(id, user.id);
      if (existing) return JSON.parse(existing.packet);
      requireState(user, row, ['EXPLAINED']);
      const explanation = JSON.parse(row.explanation);
      const packet = {
        id: randomUUID(), callId: id, claimId: row.claim_id, status: 'PREPARED', externalActionSent: false,
        verification: row.verification, risk: explanation.routing.finalRisk,
        reasonStatus: explanation.packet.reasonStatus, policySupport: explanation.packet.policySupport,
        missingInformation: explanation.packet.missingInformation, createdAt: new Date().toISOString(), provenance: 'SYNTHETIC',
      };
      store.transaction(() => {
        store.db.prepare('INSERT INTO handoffs VALUES (?,?,?,?,?)').run(packet.id, id, user.id, JSON.stringify(packet), packet.createdAt);
        update(user, row, 'ESCALATED');
        store.audit(user.id, 'Human handoff prepared', row.claim_id, 'Escalated', { callId: id, handoffId: packet.id });
      });
      return packet;
    },
    finish(user, id, cancel = false) {
      const row = getCall(user, id), target = cancel ? 'CANCELLED' : 'COMPLETED';
      if (row.state === target) return serialize(row);
      requireState(user, row, cancel ? ['CREATED', 'VERIFIED', 'MATCHED', 'INVESTIGATING', 'EXPLAINED'] : ['EXPLAINED', 'ESCALATED']);
      store.transaction(() => { update(user, row, target); store.audit(user.id, 'Call ended', id, target); });
      return serialize(getCall(user, id));
    },
    handoffs(user) { return store.db.prepare('SELECT packet FROM handoffs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id).map(r => JSON.parse(r.packet)); },
  };
}
