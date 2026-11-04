import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { digest } from './database.mjs';
import { ApiError } from './errors.mjs';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, encoded) {
  const [salt, stored] = encoded.split(':');
  const computed = scryptSync(password, salt, 64);
  return timingSafeEqual(computed, Buffer.from(stored, 'hex'));
}

export function createAuth(store, config) {
  // Reconcile the configured admin password on startup; no hard-coded password.
  if (config.adminPassword) {
    const existing = store.db.prepare('SELECT * FROM users WHERE id=?').get('demo-admin');
    const changed = !existing || existing.username !== config.adminUsername || !passwordMatches(config.adminPassword, existing.password_hash);
    if (changed) {
      store.db.prepare(`INSERT INTO users VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash`)
        .run('demo-admin', config.adminUsername, 'admin', hashPassword(config.adminPassword), new Date().toISOString());
      store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run('demo-admin');
    }
  } else {
    store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run('demo-admin');
  }

  function session(user) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + config.sessionTtlMs;
    store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(digest(token), user.id, csrfToken, expiresAt, new Date().toISOString());
    store.audit(user.id, 'Session started', user.id, 'Authenticated', { method: user.role === 'demo' ? 'synthetic-demo' : 'password' });
    return { user: { id: user.id, username: user.username, role: user.role }, token, csrfToken, expiresAt: new Date(expiresAt).toISOString(), provenance: 'SYNTHETIC' };
  }

  return {
    demo() {
      if (!config.demoMode) throw new ApiError(403, 'DEMO_DISABLED', 'Demo sessions are disabled.');
      const user = { id: randomUUID(), username: `demo-${randomUUID()}`, role: 'demo' };
      store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, user.username, user.role, null, new Date().toISOString());
      return session(user);
    },
    login(username, password) {
      const user = config.adminPassword && store.db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin'").get(username);
      const valid = user && passwordMatches(password, user.password_hash);
      // Also spend password hashing time when the username does not exist.
      if (!user) scryptSync(password, 'unknown-demo-user', 64);
      if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
      return session(user);
    },
    resolve(req) {
      const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('cc_session='))?.slice(11);
      const token = bearer || cookie;
      if (!token || token.length > 256) throw new ApiError(401, 'UNAUTHENTICATED', 'Start a demo session or sign in first.');
      const row = store.db.prepare('SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token), Date.now());
      if (!row) throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired or invalid.');
      if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== row.csrf_token) {
        throw new ApiError(403, 'CSRF_REJECTED', 'The session CSRF token is required.');
      }
      return { id: row.user_id, username: row.username, role: row.role, csrfToken: row.csrf_token, tokenHash: row.token_hash, expiresAt: new Date(row.expires_at).toISOString() };
    },
    logout(user) {
      store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(user.tokenHash);
      store.audit(user.id, 'Session ended', user.id, 'Revoked');
    },
    cookie(token, clear = false) {
      return `cc_session=${clear ? '' : token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : config.sessionTtlMs / 1000}${config.secureCookies ? '; Secure' : ''}`;
    },
  };
}
