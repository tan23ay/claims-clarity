const state = {
  claims: [],
  selectedId: null,
  claimTab: "summary",
  callStep: 0,
  callClaimId: "",
  callClaim: null,
  jev: null,
  backend: false,
  backendCall: null,
  explanation: null,
  csrfToken: null,
  meta: null,
  busy: false,
  audit: (() => {
    try {
      return JSON.parse(localStorage.getItem("claims-clarity-audit") || "[]");
    } catch {
      return [];
    }
  })()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (value) => `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (value) => new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const riskClass = (risk) => `risk-${String(risk).toLowerCase()}`;
const statusClass = (outcome) => outcome === "Denied" ? "denied" : outcome === "Partially paid" ? "partial" : "pending";

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function addAudit(event, record, result) {
  if (state.backend) { refreshAudit().catch(() => {}); return; }
  state.audit.unshift({ event, record, result, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) });
  state.audit = state.audit.slice(0, 20);
  try { localStorage.setItem("claims-clarity-audit", JSON.stringify(state.audit)); } catch { /* local persistence is optional in demo mode */ }
  renderAudit();
  renderActivity();
}

function setView(view) {
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}View`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#breadcrumbCurrent").textContent = view === "voice" ? "Voice desk" : view === "claims" ? "Claims explorer" : view[0].toUpperCase() + view.slice(1);
  if (view === "overview") renderOverview();
  if (view === "claims") renderClaims();
  if (view === "voice") renderVoice();
  if (view === "policies") renderPolicies();
  if (view === "audit") renderAudit();
}

function renderOverview() {
  const total = state.claims.length;
  const verified = state.claims.filter((claim) => claim.reasonStatus === "CONFIRMED" && claim.policySupport === "SUPPORTED").length;
  const escalated = state.claims.filter((claim) => claim.escalationRequired).length;
  const pending = state.claims.filter((claim) => claim.outcome === "Pending").length;
  $("#statGrid").innerHTML = [
    ["Total claim records", total, "synthetic claims loaded", "▤"],
    ["Verified explanations", verified, `${Math.round((verified / total) * 100)}% of records`, "✓"],
    ["Human review floor", escalated, "risk or evidence requires it", "↗"],
    ["Still in progress", pending, "pending adjudication", "◷"]
  ].map(([label, value, foot, icon]) => `<div class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><strong>${value}</strong><div class="stat-foot">${foot}</div></div>`).join("");

  const attention = state.claims.filter((claim) => claim.escalationRequired).slice(0, 5);
  $("#attentionList").innerHTML = attention.map((claim) => `<div class="attention-row" data-select-claim="${claim.id}"><span class="claim-mini-id">${claim.id.split("-")[1].slice(-3)}</span><div><div class="row-title">${claim.reasonCategory} · ${claim.id}</div><div class="row-detail">${claim.memberName} · ${claim.reasonStatus === "CONFIRMED" ? "High-risk route" : "Partial evidence"}</div></div><span class="risk-pill ${riskClass(claim.risk)}">${claim.risk}</span></div>`).join("");
  $("#activityTable").innerHTML = state.audit.length ? state.audit.slice(0, 4).map((item) => `<div class="activity-row"><span class="event">${escapeHtml(item.event)}</span><span>${escapeHtml(item.record)}</span><span class="when">${escapeHtml(item.time)}</span><b class="${item.result === "Escalated" ? "attention" : "success"}">${escapeHtml(item.result)}</b></div>`).join("") : `<div class="empty-state">No local activity yet. Select a record or start a guided call to create an audit entry.</div>`;
}

function filteredClaims() {
  const query = $("#claimSearch")?.value.trim().toLowerCase() || "";
  const outcome = $("#outcomeFilter")?.value || "ALL";
  const risk = $("#riskFilter")?.value || "ALL";
  return state.claims.filter((claim) => {
    const matchesQuery = !query || [claim.id, claim.memberName, claim.plan, claim.reasonText, claim.reasonCode, claim.reasonCategory].some((value) => value.toLowerCase().includes(query));
    return matchesQuery && (outcome === "ALL" || claim.outcome === outcome) && (risk === "ALL" || claim.risk === risk);
  });
}

function renderClaims() {
  const claims = filteredClaims();
  $("#resultCount").textContent = `${claims.length} record${claims.length === 1 ? "" : "s"}`;
  const selected = state.selectedId;
  $("#claimsTable").innerHTML = `<div class="table-head"><span>Claim / member</span><span>Reason</span><span>Outcome</span><span>Financials</span><span>Risk</span></div>` + (claims.length ? claims.map((claim) => `<div class="claim-row ${claim.id === selected ? "selected" : ""}" data-select-claim="${claim.id}"><div class="claim-cell"><strong>${claim.id}</strong><small>${claim.memberName} · ${claim.plan}</small></div><div class="claim-cell"><strong>${claim.reasonCategory}</strong><small>${claim.reasonCode}</small></div><div class="claim-cell"><span class="status-pill ${statusClass(claim.outcome)}">${claim.outcome}</span><small>${shortDate(claim.serviceDate)}</small></div><div class="claim-cell money"><strong>${money(claim.paid)}</strong><small>of ${money(claim.billed)}</small></div><div class="claim-cell"><span class="risk-pill ${riskClass(claim.risk)}">${claim.risk}</span></div></div>`).join("") : `<div class="empty-state">No exact matches. Try a claim ID, member name, plan, or reason code.</div>`);
  renderClaimDetail();
}

function renderClaimDetail() {
  const claim = state.claims.find((item) => item.id === state.selectedId);
  if (!claim) {
    $("#claimDetail").innerHTML = `<div class="empty-state" style="padding-top:140px"><div style="font-size:28px;color:#acd5c8">⌁</div><strong>Select a claim to inspect its evidence packet.</strong><p>Choose an exact record from the table.</p></div>`;
    return;
  }
  let content = "";
  if (state.claimTab === "summary") content = `<div class="fact-grid"><div class="fact"><label>Member</label><strong>${claim.memberName}</strong></div><div class="fact"><label>Member ID</label><strong>${claim.memberId}</strong></div><div class="fact"><label>Service date</label><strong>${shortDate(claim.serviceDate)}</strong></div><div class="fact"><label>As of</label><strong>Oct 10, 2026 · 08:30 ET</strong></div><div class="fact"><label>Reason status</label><strong><span class="support-pill ${claim.reasonStatus === "CONFIRMED" ? "status-pill" : "risk-pill risk-medium"}">${claim.reasonStatus.replaceAll("_", " ")}</span></strong></div><div class="fact"><label>Policy support</label><strong><span class="support-pill ${claim.policySupport === "SUPPORTED" ? "status-pill" : "risk-pill risk-medium"}">${claim.policySupport.replaceAll("_", " ")}</span></strong></div><div class="fact full"><label>Recorded adjudication reason</label><strong>${claim.reasonText}</strong></div></div>`;
  if (state.claimTab === "citation") content = `<div class="citation-card"><div class="citation-title">${claim.policy.document}</div><p>“${claim.policy.quote}”</p><div class="citation-meta">${claim.policy.section} · p. ${claim.policy.page} · effective ${claim.policy.effectiveDate}<br />content hash: ${claim.policy.hash} · plan: ${claim.plan} · version: ${claim.planVersion}</div></div><div class="detail-summary" style="margin-top:13px"><span class="summary-label">Verifier result</span><strong>PASS · citation resolves</strong><p>Document, version, effective date, and passage are attached to the selected plan. This is a synthetic verification result.</p></div>`;
  if (state.claimTab === "next") content = `<div class="next-step-list">${claim.nextSteps.map((step, index) => `<div class="next-step"><span>0${index + 1}</span><div>${step}</div></div>`).join("")}</div><div class="detail-summary" style="margin-top:16px"><span class="summary-label">Capability boundary</span><strong>No appeal submission</strong><p>The prototype can prepare a human handoff, but cannot submit an appeal or change the claim.</p></div>`;
  if (state.claimTab === "timeline") content = `<div class="timeline">${claim.events.map((event) => `<div class="timeline-item"><time>${shortDate(event.date)}</time><span class="timeline-dot"></span><div><strong>${event.label}</strong><p>${event.detail}</p></div></div>`).join("")}</div>`;

  $("#claimDetail").innerHTML = `<div class="detail-top"><div><p class="eyebrow">SELECTED RECORD</p><h2>${claim.id}</h2><p>${claim.plan} · version ${claim.planVersion}</p></div><button class="detail-close" id="closeDetail" aria-label="Close claim detail">×</button></div><div class="detail-summary"><span class="summary-label">Official adjudication outcome</span><strong>${claim.outcome} <span class="status-pill ${statusClass(claim.outcome)}">${claim.reasonCode}</span></strong><p>${claim.reasonText}. ${claim.escalationRequired ? "This record is above the human-review floor." : "This record has a supported explanation path."}</p></div><div class="detail-tabs">${[["summary", "Evidence packet"], ["citation", "Policy citation"], ["next", "Next steps"], ["timeline", "Timeline"]].map(([key, label]) => `<button class="detail-tab ${state.claimTab === key ? "active" : ""}" data-detail-tab="${key}">${label}</button>`).join("")}</div><div class="detail-content">${content}</div><div style="margin-top:18px;display:flex;gap:8px"><button class="primary-button" id="useInCall">Use in guided call <span>→</span></button><span class="mini-tag" style="align-self:center;background:#e9f2fb;color:#52799e">${claim.provenance}</span></div>`;
}

function renderPolicies() {
  const seen = new Map();
  state.claims.forEach((claim) => { if (!seen.has(claim.plan)) seen.set(claim.plan, claim); });
  $("#policyGrid").innerHTML = [...seen.values()].map((claim) => `<div class="policy-card"><h3>${claim.policy.document}</h3><p>${claim.plan} · active version ${claim.planVersion}</p><p>Effective ${claim.policy.effectiveDate} · ${claim.policy.section}</p><div class="policy-foot">${claim.policy.hash} · ${claim.provenance} · ${claim.sourceSystem}</div></div>`).join("");
}

function renderAudit() {
  const target = $("#auditList");
  if (!target) return;
  target.innerHTML = state.audit.length ? state.audit.map((item) => `<div class="audit-row"><div><strong>${escapeHtml(item.event)}</strong><small>${escapeHtml(item.record)}</small></div><span>${escapeHtml(item.record)}</span><time>${escapeHtml(item.time)}</time><span class="audit-result">${escapeHtml(item.result)}</span></div>`).join("") : `<div class="audit-empty">No local activity yet. The audit trail will appear as you explore synthetic records.</div>`;
}

function renderActivity() { if ($("#activityTable")) $("#activityTable").innerHTML = state.audit.length ? state.audit.slice(0, 4).map((item) => `<div class="activity-row"><span class="event">${escapeHtml(item.event)}</span><span>${escapeHtml(item.record)}</span><span class="when">${escapeHtml(item.time)}</span><b class="${item.result === "Escalated" ? "attention" : "success"}">${escapeHtml(item.result)}</b></div>`).join("") : `<div class="empty-state">No local activity yet. Select a record or start a guided call to create an audit entry.</div>`; }

function callStepLabel(step) { return ["Verify", "Find claim", "Explain"][step] || "Verify"; }

function renderVoice() {
  const claim = state.callClaim;
  if (state.callStep === 2 && claim && (!state.jev || state.jev.claimId !== claim.id)) state.jev = { claimId: claim.id, status: "pending" };
  const labels = ["Verify", "Find claim", "Explain"];
  const stepper = `<div class="stepper">${labels.map((label, index) => `<div class="step ${index === state.callStep ? "active" : ""} ${index < state.callStep ? "done" : ""}"><span class="step-number">${index < state.callStep ? "✓" : index + 1}</span><span>${label}</span></div>`).join("")}</div>`;
  let content = "";
  if (state.callStep === 0) content = `<h3>Let’s verify the caller first.</h3><p>This demo uses a checkbox in place of a real identity provider. Protected claim details stay hidden until verification passes.</p><div class="verify-card"><label><input type="checkbox" id="verifyCheckbox" /> <span>I confirm this is an authorized demo caller and understand that the records shown are synthetic.</span></label></div><div class="call-actions"><button class="primary-button" id="verifyButton">Continue to claim lookup <span>→</span></button></div>`;
  if (state.callStep === 1) content = `<h3>Which claim should we look up?</h3><p>Enter the full claim reference. Exact matching is required; the assistant will not guess between similar records.</p><input class="claim-input" id="callClaimInput" value="${escapeHtml(state.callClaimId)}" placeholder="CLM-PA-02600" aria-label="Claim reference" /><div class="keypad">${["1","2","3","4","5","6","7","8","9","⌫","0","C"].map((key) => `<button class="key" data-key="${key}">${key}</button>`).join("")}</div><div class="call-actions"><button class="secondary-button" id="backToVerify">← Back</button><button class="primary-button" id="lookupButton">Find exact claim <span>→</span></button></div><div class="call-actions"><button class="text-button" id="useSelectedCall">Use selected record ${state.selectedId ? `(${state.selectedId})` : ""}</button></div>`;
  if (state.callStep === 2 && claim) {
    const escalation = state.explanation?.routing.escalationRequired ?? claim.escalationRequired;
    const qualifier = claim.reasonStatus === "PARTIALLY_SUPPORTED" ? "The record supports this reason only partially, so I cannot present it as fully confirmed." : "The reason below is the documented adjudication reason in the claim record.";
    const jev = state.jev;
    const jevMarkup = jev?.status === "pending"
      ? `<div class="jev-box pending"><span class="jev-mark">J</span><div><strong>JEV shadow check running</strong><p>Advisory only. The deterministic safety floor remains authoritative.</p></div></div>`
      : jev?.status === "shadow"
        ? `<div class="jev-box"><span class="jev-mark">J</span><div><strong>JEV shadow result · ${escapeHtml(jev.model || "jev-latest")}</strong><p>Advisory risk: <b>${escapeHtml(jev.advisoryRisk || "unknown")}</b> · advisory escalation: <b>${jev.advisoryEscalate ? "yes" : "no"}</b>. Final routing remains ${escapeHtml(claim.risk)} because JEV cannot lower risk or trigger an action.</p></div></div>`
        : `<div class="jev-box muted"><span class="jev-mark">J</span><div><strong>JEV shadow mode unavailable</strong><p>The deterministic baseline is still active; no caller-facing answer depends on JEV.</p></div></div>`;
    content = `<h3>${escalation ? "Here’s what I can safely explain." : "Here’s the clear answer."}</h3><p>As of Oct 10, 2026 at 08:30 ET. I explain records and route questions; I do not make a coverage decision.</p><div class="match-card"><strong>${claim.id} · ${claim.memberName}</strong><p>${claim.plan} · service date ${shortDate(claim.serviceDate)} · ${claim.provenance} record</p></div><div class="explanation-card"><div class="spoken-label"><span>Verified spoken explanation</span><button class="speak-button" id="speakButton" aria-label="Speak explanation">◉</button></div><blockquote>Your claim ${claim.id} was recorded as <strong>${claim.outcome.toLowerCase()}</strong>. The documented reason is: ${claim.reasonText}. ${qualifier} The applicable source is ${claim.policy.document}, ${claim.policy.section}, effective ${claim.policy.effectiveDate}. ${claim.escalationRequired ? "A human review is the next permitted step." : "You can review the cited plan provision or contact the plan using the number on your member card."}</blockquote></div>${jevMarkup}${escalation ? `<div class="escalation-box"><span>↗</span><div><strong>Human review recommended</strong><p>This deterministic safety floor cannot be lowered because the risk is ${claim.risk.toLowerCase()} or the evidence is not fully supported. The demo prepares a handoff only.</p></div></div>` : ""}<div class="call-actions"><button class="secondary-button" id="restartCall">↻ Start another call</button>${escalation ? `<button class="primary-button" id="handoffButton">Prepare human handoff <span>→</span></button>` : ""}</div>`;
  }
  $("#callPanel").innerHTML = `<div class="call-header"><h2>Guided call simulation</h2><span>CALL-DEM-${state.callStep + 1} · local only</span></div>${stepper}<div class="call-content">${content}</div>`;
  if (state.backendCall) $(".call-header span").textContent = `${state.backendCall.id.slice(0, 8)} · saved on server`;
  if (state.explanation) {
    $(".explanation-card blockquote").textContent = state.explanation.text;
    if (state.explanation.jev.status === "shadow") {
      const assessment = state.explanation.jev.assessment;
      const probabilities = state.explanation.jev.answers.risk_advisory.probabilities;
      $(".jev-box p").textContent = `Advisory risk: ${state.jev.advisoryRisk}. Probabilities: low ${Math.round(probabilities.LOW * 100)}%, medium ${Math.round(probabilities.MEDIUM * 100)}%, high ${Math.round(probabilities.HIGH * 100)}%. Human-review probability: ${Math.round(assessment.escalationProbability * 100)}%. Shadow mode; operational routing remains ${state.explanation.routing.finalRisk}.`;
    }
    const complete = document.createElement("button");
    complete.id = "completeCall"; complete.className = "secondary-button";
    complete.textContent = "Complete call";
    $(".call-content .call-actions").append(complete);
  }
  $("#callStateChip").className = `call-state-chip ${state.callStep > 0 ? "active" : ""}`;
  $("#callStateChip").innerHTML = `<i></i>${state.callStep === 0 ? "Ready to start" : `Step ${state.callStep + 1} of 3 · ${callStepLabel(state.callStep)}`}`;
  if (state.callStep === 2 && claim && state.jev?.status === "pending") runJevShadow(claim);
}

async function startCall(claimId = "") {
  if (state.backend) {
    if (state.backendCall && ["CREATED", "VERIFIED", "MATCHED", "EXPLAINED"].includes(state.backendCall.state)) {
      await api(`/api/calls/${state.backendCall.id}/cancel`, "POST", {});
    }
    state.backendCall = await api("/api/calls", "POST", {});
    sessionStorage.setItem("claims-clarity-call", state.backendCall.id);
  }
  state.callStep = 0;
  state.callClaimId = claimId;
  state.callClaim = null;
  state.jev = null;
  state.explanation = null;
  setView("voice");
  addAudit("Guided call opened", claimId || "No claim selected", "Started");
}

async function handleClick(event) {
  const nav = event.target.closest(".nav-item");
  if (nav) { setView(nav.dataset.view); return; }
  const viewTarget = event.target.closest("[data-view-target]");
  if (viewTarget) { setView(viewTarget.dataset.viewTarget); return; }
  const selected = event.target.closest("[data-select-claim]");
  if (selected) { state.selectedId = selected.dataset.selectClaim; if (state.backend) await api(`/api/claims/${state.selectedId}`); state.claimTab = "summary"; renderClaims(); addAudit("Claim inspected", state.selectedId, "Viewed"); return; }
  const detailTab = event.target.closest("[data-detail-tab]");
  if (detailTab) { state.claimTab = detailTab.dataset.detailTab; renderClaimDetail(); return; }
  if (event.target.closest("#closeDetail")) { state.selectedId = null; renderClaimDetail(); return; }
  if (event.target.closest("#sessionButton")) { $("#sessionDialog").showModal(); return; }
  if (event.target.closest("#closeSessionDialog")) { $("#sessionDialog").close(); return; }
  if (event.target.closest("#newDemoSession")) { await signIn("/api/auth/demo", {}); return; }
  if (event.target.closest("#useInCall") || event.target.closest("#claimsStartCall")) { await startCall(state.selectedId || ""); return; }
  if (event.target.closest("#openVoiceButton") || event.target.closest("#heroStartCall")) { await startCall(); return; }
  if (event.target.closest("#verifyButton")) {
    if (!$("#verifyCheckbox").checked) { showToast("Please confirm the demo verification step first."); return; }
    if (state.backend) {
      if (!state.backendCall) { state.backendCall = await api("/api/calls", "POST", {}); sessionStorage.setItem("claims-clarity-call", state.backendCall.id); }
      state.backendCall = await api(`/api/calls/${state.backendCall.id}/verify`, "POST", { confirmed: true });
    }
    state.callStep = 1; renderVoice(); addAudit("Caller verification", "Demo session", "Verified"); return;
  }
  if (event.target.closest("#backToVerify")) { if (state.backend) await startCall(state.callClaimId); else { state.callStep = 0; renderVoice(); } return; }
  if (event.target.closest("#useSelectedCall")) { if (!state.selectedId) { showToast("Select a claim in Claims explorer first."); return; } state.callClaimId = state.selectedId; $("#callClaimInput").value = state.selectedId; showToast(`Loaded ${state.selectedId}`); return; }
  const key = event.target.closest("[data-key]");
  if (key) { const input = $("#callClaimInput"); const value = key.dataset.key; if (value === "C") input.value = ""; else if (value === "⌫") input.value = input.value.slice(0, -1); else input.value += value; state.callClaimId = input.value; return; }
  if (event.target.closest("#lookupButton")) {
    const id = $("#callClaimInput").value.trim().toUpperCase();
    let claim = state.claims.find((item) => item.id === id);
    if (state.backend) {
      if (state.backendCall.state === "VERIFIED") {
        const matched = await api(`/api/calls/${state.backendCall.id}/claim`, "POST", { claimId: id });
        state.backendCall = matched.call; claim = matched.claim;
      }
      state.explanation = await api(`/api/calls/${state.backendCall.id}/explanation`, "POST", {});
      state.backendCall = await api(`/api/calls/${state.backendCall.id}`);
      applyJevResult(state.explanation.jev, id);
    }
    if (!claim) { showToast("No exact match. Check the claim reference and try again."); addAudit("Claim lookup", id || "Blank reference", "No match"); return; }
    state.callClaimId = id; state.callClaim = claim; state.callStep = 2; renderVoice(); addAudit("Exact claim match", id, claim.escalationRequired ? "Escalated" : "Matched"); return;
  }
  if (event.target.closest("#restartCall")) { await startCall(); return; }
  if (event.target.closest("#completeCall")) {
    state.backendCall = await api(`/api/calls/${state.backendCall.id}/complete`, "POST", {});
    sessionStorage.removeItem("claims-clarity-call");
    state.backendCall = null; state.callClaim = null; state.explanation = null; state.jev = null; state.callStep = 0;
    renderVoice(); await refreshAudit(); showToast("Call completed and saved."); return;
  }
  if (event.target.closest("#handoffButton")) {
    if (state.backend) {
      const handoff = await api(`/api/calls/${state.backendCall.id}/handoff`, "POST", {});
      state.backendCall = await api(`/api/calls/${state.backendCall.id}`);
      showToast(`Handoff ${handoff.id.slice(0, 8)} saved for human review.`);
    } else showToast("Handoff packet prepared locally. No external action was sent.");
    addAudit("Human handoff prepared", state.callClaim?.id || "—", "Escalated"); return;
  }
  if (event.target.closest("#speakButton")) { speakClaim(); return; }
  if (event.target.closest(".dismiss-notice")) { event.target.closest(".demo-notice").remove(); return; }
  if (event.target.closest("#clearAudit")) { if (state.backend) { await refreshAudit(); showToast("Persistent audit trail refreshed."); return; } state.audit = []; try { localStorage.removeItem("claims-clarity-audit"); } catch { /* local persistence is optional in demo mode */ } renderAudit(); renderActivity(); showToast("Local activity cleared."); }
}

async function runJevShadow(claim) {
  if (!state.backend) { state.jev = { claimId: claim.id, status: "unavailable" }; renderVoice(); return; }
  try {
    const result = await api("/api/jev/shadow", "POST", { claimId: claim.id });
    if (state.callClaim?.id !== claim.id) return;
    const riskAnswer = result.answers?.risk_advisory;
    const escalationAnswer = result.answers?.should_escalate;
    state.jev = {
      claimId: claim.id,
      status: result.status === "shadow" ? "shadow" : "unavailable",
      model: result.model,
      advisoryRisk: riskAnswer?.choice,
      advisoryEscalate: escalationAnswer?.noul >= 0.5
    };
  } catch {
    state.jev = { claimId: claim.id, status: "unavailable" };
  }
  if (state.callStep === 2 && state.callClaim?.id === claim.id) renderVoice();
}

function speakClaim() {
  if (!state.callClaim) return;
  const claim = state.callClaim;
  const text = state.explanation?.text || `Your claim ${claim.id} was recorded as ${claim.outcome.toLowerCase()}. The documented reason is ${claim.reasonText}. The applicable source is ${claim.policy.document}, ${claim.policy.section}, effective ${claim.policy.effectiveDate}.`;
  if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); showToast("Playing the verified scripted explanation."); }
  else showToast("Speech synthesis is not available in this browser.");
}

document.addEventListener("click", async event => {
  if (state.busy) return;
  state.busy = true;
  try { await handleClick(event); }
  catch (error) { showToast(error.message); }
  finally { state.busy = false; }
});
$("#claimSearch").addEventListener("input", renderClaims);
$("#outcomeFilter").addEventListener("change", renderClaims);
$("#riskFilter").addEventListener("change", renderClaims);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    setView("claims");
    $("#claimSearch")?.focus();
  }
});

function initializeClaims(claims) {
    state.claims = claims;
    renderOverview();
    renderClaims();
    renderPolicies();
    renderAudit();
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) $("#sessionDialog").showModal();
    throw new Error(result.error?.message || "The request failed.");
  }
  return result;
}

function applyJevResult(result, claimId) {
  state.jev = { claimId, status: result.status === "shadow" ? "shadow" : "unavailable", model: result.model, advisoryRisk: result.answers?.risk_advisory.choice, advisoryEscalate: result.assessment?.escalationAssessment === "review" };
}

async function refreshAudit() {
  const result = await api("/api/audit");
  state.audit = result.items.map(item => ({ ...item, time: new Date(item.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) }));
  renderAudit(); renderActivity();
}

async function loadBackendData() {
  const claims = await api("/api/claims?limit=100");
  initializeClaims(claims.items);
  await refreshAudit();
  $("#systemStatus").textContent = `Backend connected · JEV ${state.meta.jev.enabled ? "shadow" : "off"}`;
  $("#clearAudit").textContent = "Refresh audit trail";
  const saved = sessionStorage.getItem("claims-clarity-call");
  if (saved) {
    try {
      const call = await api(`/api/calls/${saved}`);
      if (!["COMPLETED", "CANCELLED", "INVESTIGATING"].includes(call.state)) {
        state.backendCall = call;
        state.callClaimId = call.claimId || "";
        state.callClaim = state.claims.find(c => c.id === call.claimId) || null;
        state.explanation = call.explanation;
        state.callStep = call.explanation ? 2 : call.state === "CREATED" ? 0 : 1;
        if (call.explanation) applyJevResult(call.explanation.jev, call.claimId);
      }
    } catch { sessionStorage.removeItem("claims-clarity-call"); }
  }
}

async function signIn(path, body) {
  const result = await api(path, "POST", body);
  state.csrfToken = result.csrfToken;
  state.backendCall = null; state.explanation = null;
  sessionStorage.removeItem("claims-clarity-call");
  await loadBackendData();
  $("#sessionDialog").close();
  showToast("Session started. Calls and audit events will be saved.");
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  try { await signIn("/api/auth/login", { username: $("#loginUsername").value, password: $("#loginPassword").value }); $("#loginPassword").value = ""; }
  catch (error) { $("#loginError").textContent = error.message; }
});

async function initialize() {
  let metaResponse;
  if (location.protocol !== "file:") {
    try { metaResponse = await fetch("/api/meta"); } catch { /* static fallback below */ }
  }
  if (metaResponse?.ok && metaResponse.headers.get("content-type")?.includes("application/json")) {
    state.meta = await metaResponse.json(); state.backend = true;
    $("#newDemoSession").hidden = !state.meta.demoMode;
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (response.ok) { state.csrfToken = (await response.json()).csrfToken; await loadBackendData(); }
      else if (state.meta.demoMode) await signIn("/api/auth/demo", {});
      else { $("#systemStatus").textContent = "Sign in to connect"; $("#sessionDialog").showModal(); }
    } catch (error) { showToast(error.message); }
    return;
  }
  $("#systemStatus").textContent = "Static demo · no backend";
  $("#sessionButton").hidden = true;
  try {
    const response = await fetch("data/claims.json");
    if (!response.ok) throw new Error("Missing dataset");
    initializeClaims(await response.json());
  } catch {
    const script = document.createElement("script");
    script.src = "data/claims.js";
    script.onload = () => initializeClaims(globalThis.CLAIMS_DATA || []);
    script.onerror = () => showToast("Demo data is missing. Run node scripts/generate-data.mjs.");
    document.body.append(script);
  }
}
initialize();
