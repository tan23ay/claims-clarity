import { digest } from './database.mjs';

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const reasonStatuses = ['CONFIRMED', 'PARTIALLY_SUPPORTED', 'POSSIBLE', 'CONFLICTED', 'INSUFFICIENT_EVIDENCE'];

export function investigateClaim(claim, policy) {
  const pending = claim.outcome === 'Pending';
  const citationChecks = {
    exists: Boolean(policy && policy.quote && policy.section && policy.document && Number.isInteger(policy.page)),
    samePlan: policy?.plan === claim.plan,
    sameVersion: policy?.planVersion === claim.planVersion,
    effectiveOnServiceDate: Boolean(policy?.effectiveDate && policy.effectiveDate <= claim.serviceDate),
    quoteMatches: policy?.quote === claim.policy?.quote,
    contentHashMatches: Boolean(policy && policy.contentHash === digest(policy.quote)),
    verificationMode: 'synthetic-structural-check',
  };
  const citationValid = Object.values(citationChecks).filter(v => typeof v === 'boolean').every(Boolean);
  const policyEstablished = !pending && claim.policySupport === 'SUPPORTED' && citationValid;
  const reasonStatus = reasonStatuses.includes(claim.reasonStatus) ? claim.reasonStatus : 'INSUFFICIENT_EVIDENCE';
  const missingInformation = [];
  if (!pending && reasonStatus !== 'CONFIRMED') missingInformation.push('The synthetic extract does not contain complete corroborating evidence for the recorded reason.');
  if (!pending && !policyEstablished) missingInformation.push('An applicable, fully supported policy passage is not established.');
  const toCents = value => {
    const amount = Math.round(Number(value) * 100);
    return Number.isFinite(Number(value)) && Number(value) >= 0 && Number.isSafeInteger(amount) ? amount : null;
  };
  const billedCents = toCents(claim.billed), paidCents = toCents(claim.paid), adjustedCents = toCents(claim.adjusted);
  const arithmeticMatches = [billedCents, paidCents, adjustedCents].every(v => v !== null) && billedCents - adjustedCents === paidCents;
  if (!arithmeticMatches) missingInformation.push('The aggregate payment amounts do not reconcile.');
  const riskFloor = RISK_LEVELS.includes(claim.risk) ? claim.risk : 'HIGH';
  const escalationRequired = riskFloor === 'HIGH' || claim.escalationRequired === true || !arithmeticMatches || (!pending && (reasonStatus !== 'CONFIRMED' || !policyEstablished));
  const reasonMayBeSpoken = !pending && ['CONFIRMED', 'PARTIALLY_SUPPORTED'].includes(reasonStatus) && typeof claim.reasonText === 'string' && Boolean(claim.reasonText);
  const packet = {
    claimId: claim.id, memberName: claim.memberName, outcome: claim.outcome, asOf: claim.asOf,
    provenance: 'SYNTHETIC', sourceSystem: claim.sourceSystem, plan: claim.plan, planVersion: claim.planVersion,
    reasonStatus: pending ? 'NOT_APPLICABLE' : reasonStatus,
    reason: reasonMayBeSpoken ? { code: claim.reasonCode, text: claim.reasonText } : null,
    policySupport: pending ? 'NOT_APPLICABLE' : policyEstablished ? 'ESTABLISHED' : 'NOT_ESTABLISHED',
    citations: policyEstablished ? [policy] : [], citationChecks,
    missingInformation,
    payment: { currency: 'USD', billedCents, paidCents, adjustedCents, arithmeticMatches, verificationMode: 'aggregate-only' },
    nextSteps: escalationRequired ? ['Request a human review', 'Review the evidence packet with a demo operator'] : pending ? ['Wait for adjudication to complete', 'Request a human status check'] : ['Review the cited plan provision', 'Contact the plan using the number on the member card'],
  };
  let text = `As of ${packet.asOf}, your synthetic claim ${claim.id} was recorded as ${claim.outcome.toLowerCase()}.`;
  if (pending) text += ' Adjudication is still in progress. A final denial reason is not available.';
  else if (reasonMayBeSpoken) {
    text += ` The recorded reason is: ${packet.reason.text}.`;
    if (reasonStatus === 'PARTIALLY_SUPPORTED') text += ` ${missingInformation[0]}`;
  } else text += ' The documented reason cannot be confirmed from the available evidence.';
  if (policyEstablished) text += ` The applicable synthetic source is ${policy.document}, ${policy.section}, effective ${policy.effectiveDate}.`;
  else if (!pending) text += ' I cannot confirm the applicable policy provision from this evidence packet.';
  if (escalationRequired) text += ' A human review is the next permitted step.';
  return {
    packet,
    text,
    verified: true,
    verificationMode: 'scripted-from-synthetic-evidence',
    routing: { riskFloor, finalRisk: riskFloor, escalationRequired, source: 'deterministic', allowedActions: escalationRequired ? ['PREPARE_HANDOFF', 'END'] : ['EXPLAIN', 'PREPARE_HANDOFF', 'END'] },
  };
}
