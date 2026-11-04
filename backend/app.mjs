import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './database.mjs';
import { createAuth } from './auth.mjs';
import { createJev } from './jev.mjs';
import { createWorkflow } from './workflow.mjs';
import { investigateClaim } from './claims-engine.mjs';
import { loadConfig, projectRoot } from './config.mjs';
import { ApiError, notFound, objectBody, textField } from './errors.mjs';
import { readJson, sendJson, pageNumber, createRateLimiter } from './http.mjs';

export function createApplication({ config = loadConfig(), fetchImpl = fetch, logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  const store = new Store(config);
  const auth = createAuth(store, config);
  const jev = createJev(config, fetchImpl);
  const workflow = createWorkflow(store, config, jev);
  const rateLimit = createRateLimiter();
  // A process interruption may leave an in-flight investigation without a reply.
  for (const row of store.db.prepare("SELECT * FROM calls WHERE state='INVESTIGATING'").all()) {
    store.db.prepare("UPDATE calls SET state='MATCHED', version=version+1, updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    store.audit(row.user_id, 'Interrupted investigation recovered', row.id, 'Retry permitted');
  }
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ]);
  const assets = new Map([...staticFiles].map(([path, [file, mime]]) => [path, { content: readFileSync(join(projectRoot, file)), mime }]));
  const spec = readFileSync(join(projectRoot, 'docs/openapi.json'));

  async function dispatch(req, res, url) {
    const path = url.pathname, method = req.method;
    const json = (body, status = 200, headers = {}) => sendJson(res, status, body, headers);
    if (method === 'GET' && path === '/api/health') {
      store.db.prepare('SELECT 1').get();
      return json({ status: 'ok', database: 'ok', appEnv: config.appEnv, provenance: 'SYNTHETIC' });
    }
    if (method === 'GET' && path === '/api/meta') return json({ name: 'Claims Clarity', version: '0.2.0', demoMode: config.demoMode, adminLoginAvailable: Boolean(config.adminPassword), dataProvenance: 'SYNTHETIC', jev: { enabled: config.jevEnabled, mode: 'shadow', model: config.jevModel }, callerVerification: 'synthetic-checkbox', telephony: 'unavailable' });
    if (method === 'GET' && path === '/api/openapi.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(spec); }
    if (method === 'POST' && ['/api/auth/demo', '/api/auth/login'].includes(path)) {
      rateLimit(`login:${req.socket.remoteAddress}`, 20);
      const body = await readJson(req);
      let session;
      if (path === '/api/auth/demo') { objectBody(body, []); session = auth.demo(); }
      else {
        objectBody(body, ['username', 'password'], ['username', 'password']);
        if (typeof body.password !== 'string' || !body.password || body.password.length > 256) throw new ApiError(400, 'INVALID_FIELD', 'Invalid password.');
        session = auth.login(textField(body.username, 'username'), body.password);
      }
      return json(session, 201, { 'Set-Cookie': auth.cookie(session.token) });
    }
    if (['GET', 'HEAD'].includes(method) && assets.has(path)) {
      const asset = assets.get(path);
      res.writeHead(200, { 'Content-Type': `${asset.mime}; charset=utf-8` });
      return res.end(method === 'HEAD' ? undefined : asset.content);
    }
    if (!path.startsWith('/api/') && !['/data/claims.json', '/data/claims.js'].includes(path)) throw notFound();
    const user = auth.resolve(req);
    if (method === 'GET' && path === '/api/auth/me') return json({ user: { id: user.id, username: user.username, role: user.role }, csrfToken: user.csrfToken, expiresAt: user.expiresAt });
    if (method === 'POST' && path === '/api/auth/logout') {
      objectBody(await readJson(req), []); auth.logout(user);
      return json({ status: 'logged_out' }, 200, { 'Set-Cookie': auth.cookie('', true) });
    }
    if (method === 'GET' && ['/data/claims.json', '/data/claims.js'].includes(path)) {
      const claims = store.claims({ limit: 100 }).items;
      if (path.endsWith('.json')) return json(claims);
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(`globalThis.CLAIMS_DATA = ${JSON.stringify(claims)};`);
    }
    if (method === 'GET' && path === '/api/claims') {
      const q = url.searchParams.get('q') || '';
      if (q.length > 100) throw new ApiError(400, 'INVALID_QUERY', 'Search query is too long.');
      const outcome = url.searchParams.get('outcome') || undefined, risk = url.searchParams.get('risk') || undefined, escalation = url.searchParams.get('escalation');
      if ((outcome && !['Denied', 'Partially paid', 'Pending'].includes(outcome)) || (risk && !['LOW', 'MEDIUM', 'HIGH'].includes(risk)) || (escalation !== null && !['true', 'false'].includes(escalation))) throw new ApiError(400, 'INVALID_FILTER', 'Invalid claim filter.');
      const limit = pageNumber(url.searchParams.get('limit'), 50, 100), offset = pageNumber(url.searchParams.get('offset'), 0, 10_000);
      if (limit === 0) throw new ApiError(400, 'INVALID_PAGINATION', 'Limit must be positive.');
      return json(store.claims({ q, outcome, risk, escalation: escalation === null ? undefined : escalation === 'true', limit, offset }));
    }
    const claimRoute = path.match(/^\/api\/claims\/([^/]+)(\/evidence)?$/);
    if (method === 'GET' && claimRoute) {
      const claim = store.claim(claimRoute[1]); if (!claim) throw notFound();
      store.audit(user.id, 'Claim inspected', claim.id, 'Viewed');
      return json(claimRoute[2] ? investigateClaim(claim, store.policy(claim.policyId)).packet : claim);
    }
    if (method === 'GET' && path === '/api/policies') {
      const items = store.db.prepare('SELECT payload FROM policies ORDER BY plan, plan_version').all().map(r => JSON.parse(r.payload))
        .filter(p => (!url.searchParams.get('plan') || p.plan === url.searchParams.get('plan')) && (!url.searchParams.get('version') || p.planVersion === url.searchParams.get('version')));
      return json({ items, total: items.length, provenance: 'SYNTHETIC' });
    }
    const policyRoute = path.match(/^\/api\/policies\/([^/]+)$/);
    if (method === 'GET' && policyRoute) {
      const policy = store.policy(policyRoute[1]); if (!policy) throw notFound();
      store.audit(user.id, 'Policy inspected', policy.id, 'Viewed'); return json(policy);
    }
    if (method === 'GET' && path === '/api/stats') {
      const claims = store.claims({ limit: 100 }).items;
      const analyses = claims.map(c => investigateClaim(c, store.policy(store.claim(c.id).policyId)));
      const calls = workflow.list(user);
      return json({ claims: { total: claims.length, verifiedEvidence: analyses.filter(a => a.packet.reasonStatus === 'CONFIRMED' && a.packet.policySupport === 'ESTABLISHED').length, requiresReview: analyses.filter(a => a.routing.escalationRequired).length, pending: claims.filter(c => c.outcome === 'Pending').length }, calls: { total: calls.length, completed: calls.filter(c => c.state === 'COMPLETED').length, escalated: calls.filter(c => c.state === 'ESCALATED').length, active: calls.filter(c => !['COMPLETED', 'CANCELLED', 'ESCALATED'].includes(c.state)).length }, metricsScope: 'current-session-owner; most recent 100 calls', provenance: 'SYNTHETIC' });
    }
    if (path === '/api/calls' && method === 'GET') return json({ items: workflow.list(user), provenance: 'SYNTHETIC' });
    if (path === '/api/calls' && method === 'POST') { objectBody(await readJson(req), []); return json(workflow.create(user), 201); }
    const callRoute = path.match(/^\/api\/calls\/([^/]+)(?:\/(verify|claim|explanation|handoff|complete|cancel))?$/);
    if (callRoute) {
      const [, id, action] = callRoute;
      if (method === 'GET' && !action) return json(workflow.get(user, id));
      if (method === 'POST') {
        const body = await readJson(req);
        if (action === 'verify') { objectBody(body, ['confirmed'], ['confirmed']); return json(workflow.verify(user, id, body.confirmed)); }
        if (action === 'claim') { objectBody(body, ['claimId'], ['claimId']); return json(workflow.match(user, id, textField(body.claimId, 'claimId'))); }
        objectBody(body, []);
        if (action === 'explanation') { rateLimit(`jev:${user.id}`, 10); return json(await workflow.explain(user, id)); }
        if (action === 'handoff') return json(workflow.handoff(user, id));
        if (action === 'complete' || action === 'cancel') return json(workflow.finish(user, id, action === 'cancel'));
      }
    }
    if (method === 'POST' && path === '/api/jev/shadow') {
      rateLimit(`jev:${user.id}`, 10);
      const body = objectBody(await readJson(req), ['claimId'], ['claimId']);
      const claim = store.claim(textField(body.claimId, 'claimId')); if (!claim) throw notFound();
      return json(await workflow.shadow(user, claim));
    }
    if (method === 'GET' && path === '/api/handoffs') return json({ items: workflow.handoffs(user), provenance: 'SYNTHETIC' });
    if (method === 'GET' && path === '/api/audit') {
      store.audit(user.id, 'Audit trail viewed', user.id, 'Viewed');
      return json({ items: store.auditList(user, Math.max(1, pageNumber(url.searchParams.get('limit'), 100, 200))), appendOnly: true });
    }
    if (path.startsWith('/api/admin/')) {
      if (user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'An administrator session is required.');
      if (method === 'GET' && path === '/api/admin/audit/integrity') return json(store.verifyAudit());
      if (method === 'GET' && path === '/api/admin/dataset') return json(store.claims({ limit: 100 }), 200, { 'Content-Disposition': 'attachment; filename="synthetic-claims.json"' });
    }
    throw notFound();
  }

  const server = createServer(async (req, res) => {
    const requestId = randomUUID(), started = Date.now();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      rateLimit(`requests:${req.socket.remoteAddress}`, 300);
      const origin = req.headers.origin;
      if (origin) {
        const sameHostOrigins = [`http://${req.headers.host}`, `https://${req.headers.host}`];
        if (!config.corsOrigins.includes(origin) && !sameHostOrigins.includes(origin)) throw new ApiError(403, 'ORIGIN_REJECTED', 'This origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token' });
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      await dispatch(req, res, url);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 429) res.setHeader('Retry-After', '60');
      if (!res.headersSent) sendJson(res, status, { error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : 'An internal error occurred.', requestId } });
      else res.end();
      if (status === 500) logger({ level: 'error', requestId, code: 'INTERNAL_ERROR' });
    } finally {
      logger({ level: 'info', requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - started });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, store, config, close: () => new Promise(resolve => { server.close(() => { store.close(); resolve(); }); server.closeIdleConnections(); }) };
}
