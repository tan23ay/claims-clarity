import { mkdir, writeFile } from "node:fs/promises";

const categories = [
  ["Prior authorization", "Authorization missing or not found", "AUTH-01", "CLM-PA", "HIGH"],
  ["Coverage exclusion", "Service excluded under plan terms", "EXC-04", "CLM-EX", "MEDIUM"],
  ["Documentation", "Clinical documentation was incomplete", "DOC-02", "CLM-DO", "MEDIUM"],
  ["Eligibility", "Coverage was inactive on the service date", "ELG-03", "CLM-EL", "HIGH"],
  ["Coding discrepancy", "Submitted code did not match the claim record", "COD-07", "CLM-CO", "MEDIUM"],
  ["Duplicate claim", "A matching claim was already processed", "DUP-01", "CLM-DU", "LOW"],
  ["Timely filing", "Claim received after the filing window", "TIM-05", "CLM-TF", "HIGH"],
  ["Partial payment", "Some claim lines were paid and others were adjusted", "PAY-11", "CLM-PP", "MEDIUM"],
  ["Pending review", "Adjudication is still in progress", "PND-00", "CLM-PN", "MEDIUM"],
  ["Coordination of benefits", "Other coverage information is needed", "COB-08", "CLM-CB", "HIGH"]
];

const firstNames = ["Jordan", "Riley", "Avery", "Morgan", "Casey", "Taylor", "Quinn", "Drew", "Cameron", "Emerson"];
const lastNames = ["Patel", "Morgan", "Kim", "Reed", "Nguyen", "Brooks", "Shah", "Rivera", "Bennett", "Stone"];
const plans = ["Silver Choice PPO", "Essential HMO", "Select Plus PPO", "Community Care HMO", "Value Network EPO"];
const dates = ["2026-09-03", "2026-09-11", "2026-09-18", "2026-09-26", "2026-10-02"];
const adjudicationOutcomes = ["Denied", "Denied", "Partially paid", "Pending"];

function createClaim(index) {
  const category = categories[index % categories.length];
  const [reasonCategory, reasonText, reasonCode, prefix, defaultRisk] = category;
  const member = `${firstNames[index % firstNames.length]} ${lastNames[(index * 3) % lastNames.length]}`;
  const claimId = `${prefix}-${String(2600 + index).padStart(5, "0")}`;
  const serviceDate = dates[index % dates.length];
  const outcome = reasonCategory === "Pending review" ? "Pending" : adjudicationOutcomes[index % adjudicationOutcomes.length];
  const isPartial = reasonCategory === "Partial payment" || outcome === "Partially paid";
  const risk = reasonCategory === "Pending review" ? "MEDIUM" : defaultRisk;
  const reasonStatus = reasonCategory === "Documentation" && index % 2 === 0 ? "PARTIALLY_SUPPORTED" : "CONFIRMED";
  const policySupport = reasonCategory === "Pending review" ? "NOT_APPLICABLE" : index % 7 === 0 ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  const escalationRequired = risk === "HIGH" || reasonStatus !== "CONFIRMED" || policySupport === "PARTIALLY_SUPPORTED";
  const allowedNextSteps = reasonCategory === "Pending review"
    ? ["Wait for adjudication to complete", "Request a human status check"]
    : escalationRequired
      ? ["Request a human review", "Ask for the applicable notice or plan document"]
      : ["Review the cited plan provision", "Contact the plan using the number on the member card"];
  const paid = isPartial ? 120 + (index % 4) * 35 : outcome === "Denied" ? 0 : 280 + (index % 5) * 45;
  const billed = 520 + (index % 6) * 90;

  return {
    id: claimId,
    memberName: member,
    memberId: `SYN-${String(800000 + index * 37).slice(0, 6)}`,
    plan: plans[index % plans.length],
    planVersion: `2026.${String((index % 3) + 1).padStart(2, "0")}`,
    serviceDate,
    receivedDate: `2026-09-${String(5 + (index % 20)).padStart(2, "0")}`,
    outcome,
    reasonCategory,
    reasonText,
    reasonCode,
    billed,
    paid,
    adjusted: billed - paid,
    risk,
    reasonStatus,
    policySupport,
    escalationRequired,
    provenance: "SYNTHETIC",
    sourceSystem: "Demo claims extract",
    asOf: "2026-10-10T08:30:00-04:00",
    confidence: reasonStatus === "CONFIRMED" && policySupport === "SUPPORTED" ? 0.98 : 0.82,
    policy: {
      document: `${plans[index % plans.length]} Member Certificate`,
      section: reasonCategory === "Coverage exclusion" ? "Section 7.2 - Excluded services" : "Section 4.1 - Claim review and adjustments",
      page: 12 + (index % 9),
      effectiveDate: "2026-01-01",
      quote: reasonCategory === "Pending review"
        ? "Claims remain pending until all required review steps are complete."
        : reasonText + ". The plan may request supporting information before finalizing payment.",
      hash: `demo-hash-${String(index + 1).padStart(3, "0")}`
    },
    nextSteps: allowedNextSteps,
    events: [
      { date: `2026-09-${String(5 + (index % 20)).padStart(2, "0")}`, label: "Claim received", detail: "Loaded from the synthetic demo extract." },
      { date: `2026-09-${String(8 + (index % 20)).padStart(2, "0")}`, label: outcome === "Pending" ? "Review opened" : "Adjudication recorded", detail: outcome === "Pending" ? "Additional review is still in progress." : `${reasonCode} recorded on the adjudication snapshot.` },
      { date: "2026-10-10", label: "Available to assistant", detail: "Evidence packet generated for this demo session." }
    ]
  };
}

await mkdir("data", { recursive: true });
const claims = Array.from({ length: 50 }, (_, index) => createClaim(index));
await writeFile("data/claims.json", JSON.stringify(claims, null, 2));
await writeFile("data/claims.js", `globalThis.CLAIMS_DATA = ${JSON.stringify(claims)};`);
console.log("Generated 50 synthetic claim records in data/claims.json");
