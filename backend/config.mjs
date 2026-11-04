import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function integer(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

function probability(env, key, fallback) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${key}`);
  return value;
}

function flag(env, key, fallback) {
  const value = env[key] ?? String(fallback);
  if (!['true', 'false'].includes(value)) throw new Error(`${key} must be true or false`);
  return value === 'true';
}

export function loadConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'demo';
  if (!['demo', 'test'].includes(appEnv)) {
    throw new Error('This repository serves synthetic demo records. APP_ENV must be demo or test; production integrations are not implemented.');
  }
  const demoMode = flag(env, 'DEMO_MODE', true);
  const adminPassword = env.DEMO_ADMIN_PASSWORD || '';
  if (adminPassword && adminPassword.length < 12) throw new Error('DEMO_ADMIN_PASSWORD must contain at least 12 characters');
  if (!demoMode && !adminPassword) throw new Error('Configure DEMO_ADMIN_PASSWORD when DEMO_MODE is false');
  const jevEnabled = flag(env, 'JEV_ENABLED', false);
  const jevModel = env.JEV_MODEL || 'jev-1.13.0';
  if (!/^jev-\d+\.\d+\.\d+$/.test(jevModel)) throw new Error('JEV_MODEL must be an exact version, such as jev-1.13.0');
  const jevApiKey = env.JEV_API_KEY || env.TYPESAFE_API_KEY || '';
  if (jevEnabled && (!jevApiKey || jevApiKey.startsWith('sk-or-'))) {
    throw new Error('JEV_ENABLED requires a TypeSafe-issued key. An OpenRouter key is not accepted by this direct adapter.');
  }
  const corsOrigins = (env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins');
  }
  return {
    appEnv, demoMode, adminPassword,
    adminUsername: env.DEMO_ADMIN_USERNAME || 'admin',
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 4173, 0, 65535),
    databasePath: env.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(projectRoot, env.DATABASE_PATH || 'storage/claims.sqlite'),
    seedPath: resolve(projectRoot, 'data/claims.json'),
    secureCookies: flag(env, 'COOKIE_SECURE', false),
    sessionTtlMs: integer(env, 'SESSION_TTL_MINUTES', 60, 1, 1440) * 60_000,
    maxLookups: integer(env, 'MAX_CALL_LOOKUPS', 5, 1, 20),
    corsOrigins,
    jevEnabled, jevApiKey, jevModel,
    jevTimeoutMs: integer(env, 'JEV_TIMEOUT_MS', 2500, 100, 15_000),
    jevMinConfidence: probability(env, 'JEV_MIN_CONFIDENCE', 0.8),
    jevMinMargin: probability(env, 'JEV_MIN_MARGIN', 0.2),
    jevEscalationThreshold: probability(env, 'JEV_ESCALATION_THRESHOLD', 0.8),
    jevCircuitCooldownMs: 30_000,
  };
}
