import { mkdir, writeFile } from 'node:fs/promises';
import { projectRoot } from '../backend/config.mjs';
import { join } from 'node:path';

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required });
const body = (properties = {}, required = []) => ({ required: true, content: { 'application/json': { schema: { ...object(properties, required), additionalProperties: false } } } });
const schemaResponse = schema => ({ description: 'Successful response', content: { 'application/json': { schema } } });
const paths = {};
function route(path, method, summary, response, input, isPublic = false, status = 200, parameters = []) {
  paths[path] ||= {};
  paths[path][method] = {
    summary, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    ...(isPublic ? { security: [] } : {}),
    ...(input ? { requestBody: input } : {}),
    parameters: [...(path.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: string }] : []), ...parameters],
    responses: { [status]: schemaResponse(response), default: { description: 'Structured API error', content: { 'application/json': { schema: ref('Error') } } } },
  };
}
const paged = name => object({ items: { type: 'array', items: ref(name) }, total: { type: 'integer' }, provenance: { const: 'SYNTHETIC' } }, ['items']);
route('/api/health', 'get', 'Read health and database readiness', ref('Health'), null, true);
route('/api/meta', 'get', 'Read demo and integration capabilities', { type: 'object' }, null, true);
route('/api/openapi.json', 'get', 'Read this API specification', { type: 'object' }, null, true);
route('/api/auth/demo', 'post', 'Create an isolated synthetic demo operator session', ref('Session'), body(), true, 201);
route('/api/auth/login', 'post', 'Sign in as the configured demo administrator', ref('Session'), body({ username: string, password: { type: 'string', format: 'password', maxLength: 256 } }, ['username', 'password']), true, 201);
route('/api/auth/me', 'get', 'Read the current user and CSRF token', ref('Session'));
route('/api/auth/logout', 'post', 'Revoke the current session', { type: 'object' }, body());
route('/api/claims', 'get', 'Search and paginate synthetic claims', paged('Claim'), null, false, 200, [
  ...['q', 'outcome', 'risk', 'escalation'].map(name => ({ name, in: 'query', schema: string })),
  ...['limit', 'offset'].map(name => ({ name, in: 'query', schema: { type: 'integer', minimum: 0, maximum: name === 'limit' ? 100 : 10000 } })),
]);
route('/api/claims/{id}', 'get', 'Read an exact synthetic claim', ref('Claim'));
route('/api/claims/{id}/evidence', 'get', 'Inspect deterministic evidence and citation checks', ref('Evidence'));
route('/api/policies', 'get', 'List versioned synthetic policy passages', paged('Policy'), null, false, 200, ['plan', 'version'].map(name => ({ name, in: 'query', schema: string })));
route('/api/policies/{id}', 'get', 'Read a synthetic policy passage', ref('Policy'));
route('/api/stats', 'get', 'Read counts derived from database records', { type: 'object' });
route('/api/calls', 'get', 'List calls owned by the current user', paged('Call'));
route('/api/calls', 'post', 'Create a caller workflow', ref('Call'), body(), false, 201);
route('/api/calls/{id}', 'get', 'Read an owned caller workflow', ref('Call'));
route('/api/calls/{id}/verify', 'post', 'Confirm synthetic caller verification', ref('Call'), body({ confirmed: { const: true } }, ['confirmed']));
route('/api/calls/{id}/claim', 'post', 'Match a verified caller to an exact claim', object({ call: ref('Call'), claim: ref('Claim') }), body({ claimId: string }, ['claimId']));
route('/api/calls/{id}/explanation', 'post', 'Build and persist an evidence-grounded explanation', ref('Explanation'), body());
route('/api/calls/{id}/handoff', 'post', 'Prepare an idempotent human handoff', ref('Handoff'), body());
route('/api/calls/{id}/complete', 'post', 'Complete an explained or escalated call', ref('Call'), body());
route('/api/calls/{id}/cancel', 'post', 'Cancel an active demo workflow', ref('Call'), body());
route('/api/jev/shadow', 'post', 'Evaluate an existing synthetic claim in JEV shadow mode', ref('JevResult'), body({ claimId: string }, ['claimId']));
route('/api/handoffs', 'get', 'List prepared handoffs owned by the current user', paged('Handoff'));
route('/api/audit', 'get', 'Read the append-only audit trail in user scope', paged('Audit'), null, false, 200, [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }]);
route('/api/admin/audit/integrity', 'get', 'Administrator: verify the entire audit hash chain', { type: 'object' });
route('/api/admin/dataset', 'get', 'Administrator: export all 50 synthetic records', paged('Claim'));

const schema = {
  openapi: '3.1.0',
  info: { title: 'Claims Clarity Backend', version: '0.2.0', description: 'Synthetic demo API. Cookie sessions require X-CSRF-Token on POST requests; bearer sessions do not. All claims are synthetic. Caller verification is a simulated checkbox.' },
  servers: [{ url: 'http://localhost:4173', description: 'Local frontend + backend' }],
  security: [{ bearerAuth: [] }, { cookieAuth: [] }], paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'cc_session' } },
    schemas: {
      Error: object({ error: object({ code: string, message: string, requestId: string }, ['code', 'message', 'requestId']) }, ['error']),
      Health: object({ status: { const: 'ok' }, database: { const: 'ok' }, appEnv: string, provenance: { const: 'SYNTHETIC' } }, ['status', 'database']),
      Session: object({ user: object({ id: string, username: string, role: { enum: ['demo', 'admin'] } }), token: string, csrfToken: string, expiresAt: { type: 'string', format: 'date-time' } }, ['user', 'csrfToken', 'expiresAt']),
      Claim: object({ id: string, memberName: string, memberId: string, plan: string, planVersion: string, serviceDate: string, outcome: { enum: ['Denied', 'Partially paid', 'Pending'] }, risk: { enum: ['LOW', 'MEDIUM', 'HIGH'] }, reasonStatus: string, policySupport: string, escalationRequired: { type: 'boolean' }, billed: { type: 'number' }, paid: { type: 'number' }, adjusted: { type: 'number' }, policy: ref('Policy'), provenance: { const: 'SYNTHETIC' } }, ['id', 'provenance']),
      Policy: object({ id: string, document: string, section: string, page: { type: 'integer' }, effectiveDate: string, quote: string, hash: string, contentHash: string, plan: string, planVersion: string, provenance: { const: 'SYNTHETIC' } }),
      Evidence: object({ claimId: string, outcome: string, asOf: string, reasonStatus: string, policySupport: string, citations: { type: 'array', items: ref('Policy') }, missingInformation: { type: 'array', items: string }, payment: { type: 'object' }, provenance: { const: 'SYNTHETIC' } }),
      Call: object({ id: string, state: { enum: ['CREATED', 'VERIFIED', 'MATCHED', 'INVESTIGATING', 'EXPLAINED', 'ESCALATED', 'COMPLETED', 'CANCELLED'] }, claimId: { type: ['string', 'null'] }, version: { type: 'integer' }, explanation: { anyOf: [ref('Explanation'), { type: 'null' }] }, provenance: { const: 'SYNTHETIC' } }, ['id', 'state']),
      Explanation: object({ text: string, verified: { const: true }, verificationMode: string, packet: ref('Evidence'), routing: { type: 'object' }, jev: ref('JevResult'), provenance: { const: 'SYNTHETIC' } }, ['text', 'packet', 'routing', 'jev']),
      Handoff: object({ id: string, callId: string, claimId: string, status: { const: 'PREPARED' }, externalActionSent: { const: false }, provenance: { const: 'SYNTHETIC' } }, ['id', 'status']),
      JevResult: object({ status: { enum: ['shadow', 'unavailable'] }, mode: { const: 'shadow' }, advisoryOnly: { const: true }, reason: string, model: string, answers: { type: 'object' }, assessment: { type: 'object' }, finalRouting: { type: 'object' } }, ['status', 'mode', 'advisoryOnly']),
      Audit: object({ sequence: { type: 'integer' }, id: string, event: string, record: string, result: string, createdAt: string, previousHash: string, hash: string }),
    },
  },
};
await mkdir(join(projectRoot, 'docs'), { recursive: true });
await writeFile(join(projectRoot, 'docs/openapi.json'), JSON.stringify(schema, null, 2) + '\n');
console.log(`Generated OpenAPI specification with ${Object.keys(paths).length} routes.`);
