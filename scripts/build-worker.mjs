import { mkdir, readFile, writeFile } from "node:fs/promises";

// The supported backend now uses the persistent Node/SQLite service. This legacy
// packager trusted client claim payloads and cannot provide that workflow.
throw new Error("Legacy Worker packaging is retired. Use node server.mjs or docker compose up --build for the complete backend.");

const files = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/data/claims.js": "data/claims.js",
  "/data/claims.json": "data/claims.json"
};

const assets = {};
for (const [route, filename] of Object.entries(files)) {
  assets[route] = (await readFile(filename)).toString("base64");
}

const worker = `const ASSETS = ${JSON.stringify(assets)};

const TYPES = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/data/claims.js": "text/javascript; charset=utf-8",
  "/data/claims.json": "application/json; charset=utf-8"
};

function assetResponse(pathname) {
  const encoded = ASSETS[pathname];
  if (!encoded) return null;
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": TYPES[pathname], "Cache-Control": "no-store" } });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
  });
}

async function jevShadow(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" } });
  if (request.method !== "POST") return json({ status: "method_not_allowed" }, 405);
  if (!env.JEV_API_KEY) return json({ status: "unavailable", reason: "JEV runtime secret is not configured" }, 503);

  let input;
  try { input = await request.json(); } catch { return json({ status: "invalid_request" }, 400); }
  const claim = input?.claim || {};
  if (claim.provenance !== "SYNTHETIC") return json({ status: "blocked", reason: "Only synthetic demo records are allowed in shadow mode" }, 403);

  const safeState = {
    claim_id: String(claim.id || ""),
    outcome: String(claim.outcome || ""),
    reason_category: String(claim.reasonCategory || ""),
    risk_floor: String(claim.risk || "MEDIUM"),
    reason_status: String(claim.reasonStatus || ""),
    policy_support: String(claim.policySupport || ""),
    provenance: "SYNTHETIC"
  };

  const upstream = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.JEV_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.JEV_MODEL || "jev-latest",
      state: safeState,
      questions: {
        risk_advisory: {
          type: "choice",
          instructions: "Choose an advisory risk level for this synthetic claim. This cannot lower the deterministic risk floor and cannot authorize or trigger an action.",
          criteria: {
            LOW: "Routine supported explanation with no escalation signal.",
            MEDIUM: "Pending, partial, or ambiguous evidence that may need review.",
            HIGH: "High-risk category, authority concern, or strong escalation signal."
          }
        },
        should_escalate: {
          type: "noul",
          instructions: "Should a human review this synthetic claim before a caller receives a definitive explanation?",
          criteria: { true: "Evidence, authority, or risk requires human review.", false: "A verified explanation can be delivered from the evidence packet." }
        }
      }
    })
  });

  if (!upstream.ok) return json({ status: "error", reason: "JEV request failed", upstream_status: upstream.status }, 502);
  const result = await upstream.json();
  return json({ status: "shadow", model: result.model || env.JEV_MODEL || "jev-latest", answers: result.answers || {}, usage: result.usage || null, advisoryOnly: true, deterministicFloor: safeState.risk_floor });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/jev/shadow") return jevShadow(request, env);
    return assetResponse(url.pathname === "" ? "/" : url.pathname) || new Response("Not found", { status: 404 });
  }
};
`;

await mkdir("dist/server", { recursive: true });
await writeFile("dist/server/index.js", worker);
console.log("Built Worker bundle with embedded static UI assets and /api/jev/shadow.");
