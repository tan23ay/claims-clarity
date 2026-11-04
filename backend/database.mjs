import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(config) {
    if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
    this.db = new DatabaseSync(config.databasePath, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
    const folder = fileURLToPath(new URL('./migrations/', import.meta.url));
    for (const filename of readdirSync(folder).filter(v => v.endsWith('.sql')).sort()) {
      if (!this.db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(filename)) {
        this.transaction(() => {
          this.db.exec(readFileSync(join(folder, filename), 'utf8'));
          this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(filename, new Date().toISOString());
        });
      }
    }
    this.seed(config.seedPath);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  seed(path) {
    if (this.db.prepare('SELECT count(*) AS count FROM claims').get().count) return;
    const claims = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(claims) || claims.length !== 50 || new Set(claims.map(c => c.id)).size !== 50 || claims.some(c => c.provenance !== 'SYNTHETIC')) {
      throw new Error('Seed requires exactly 50 unique synthetic claims');
    }
    this.transaction(() => {
      for (const claim of claims) {
        const contentHash = digest(claim.policy.quote);
        const policyId = digest(`${claim.plan}|${claim.planVersion}|${claim.policy.hash}`);
        const policy = { ...claim.policy, id: policyId, plan: claim.plan, planVersion: claim.planVersion, contentHash, provenance: 'SYNTHETIC' };
        this.db.prepare('INSERT OR IGNORE INTO policies VALUES (?, ?, ?, ?, ?)').run(policyId, claim.plan, claim.planVersion, contentHash, JSON.stringify(policy));
        this.db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(claim.id, claim.plan, claim.planVersion, policyId, claim.outcome, claim.risk, 'SYNTHETIC', JSON.stringify(claim));
      }
    });
  }

  claim(id) {
    const row = this.db.prepare('SELECT payload, policy_id FROM claims WHERE id = ?').get(id);
    return row ? { ...JSON.parse(row.payload), policyId: row.policy_id } : null;
  }

  claims({ q = '', outcome, risk, escalation, offset = 0, limit = 50 } = {}) {
    // Fixed dataset, parameterized SQL, bounded pagination. Search is literal, never SQL.
    let items = this.db.prepare('SELECT payload FROM claims ORDER BY id').all().map(row => JSON.parse(row.payload));
    const query = q.toLowerCase();
    items = items.filter(c => (!query || [c.id, c.memberName, c.plan, c.reasonCategory, c.reasonCode, c.reasonText].some(v => v.toLowerCase().includes(query)))
      && (!outcome || c.outcome === outcome) && (!risk || c.risk === risk) && (escalation === undefined || c.escalationRequired === escalation));
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, provenance: 'SYNTHETIC' };
  }

  policy(id) {
    const row = this.db.prepare('SELECT payload FROM policies WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  audit(userId, event, record, result, details = {}) {
    const previousHash = this.db.prepare('SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get()?.hash || 'GENESIS';
    const entry = { id: randomUUID(), userId, event, record, result, details, createdAt: new Date().toISOString(), previousHash };
    const hash = digest(JSON.stringify(entry));
    this.db.prepare('INSERT INTO audit_events(id,user_id,event,record_id,result,details,created_at,previous_hash,hash) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(entry.id, userId, event, record, result, JSON.stringify(details), entry.createdAt, previousHash, hash);
    return { ...entry, hash };
  }

  auditList(user, limit = 100) {
    const sql = user.role === 'admin' ? 'SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?' : 'SELECT * FROM audit_events WHERE user_id = ? ORDER BY sequence DESC LIMIT ?';
    const rows = user.role === 'admin' ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all(user.id, limit);
    return rows.map(r => ({ sequence: r.sequence, id: r.id, event: r.event, record: r.record_id, result: r.result, details: JSON.parse(r.details), createdAt: r.created_at, previousHash: r.previous_hash, hash: r.hash }));
  }

  verifyAudit() {
    let previousHash = 'GENESIS';
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
    for (const r of rows) {
      const entry = { id: r.id, userId: r.user_id, event: r.event, record: r.record_id, result: r.result, details: JSON.parse(r.details), createdAt: r.created_at, previousHash: r.previous_hash };
      if (r.previous_hash !== previousHash || digest(JSON.stringify(entry)) !== r.hash) return { valid: false, checked: rows.length, failedAt: r.sequence };
      previousHash = r.hash;
    }
    return { valid: true, checked: rows.length, headHash: previousHash };
  }

  close() { this.db.close(); }
}
