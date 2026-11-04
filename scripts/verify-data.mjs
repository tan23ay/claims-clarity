import { readFile } from "node:fs/promises";

const claims = JSON.parse(await readFile("data/claims.json", "utf8"));

if (!Array.isArray(claims) || claims.length !== 50) {
  throw new Error(`Expected exactly 50 claim records, found ${claims.length}`);
}

const requiredFields = ["id", "memberName", "outcome", "risk", "reasonStatus", "policySupport", "provenance", "policy"];
for (const [index, claim] of claims.entries()) {
  for (const field of requiredFields) {
    if (claim[field] === undefined || claim[field] === null || claim[field] === "") {
      throw new Error(`Claim ${index + 1} is missing required field: ${field}`);
    }
  }
  if (claim.provenance !== "SYNTHETIC") {
    throw new Error(`Claim ${claim.id} is not marked SYNTHETIC`);
  }
}

console.log(`Verified ${claims.length} synthetic claim records.`);

