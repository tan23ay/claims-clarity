CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('demo', 'admin')),
  password_hash TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES policies(id),
  outcome TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('LOW', 'MEDIUM', 'HIGH')),
  provenance TEXT NOT NULL CHECK(provenance = 'SYNTHETIC'),
  payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX claims_filters ON claims(outcome, risk);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('CREATED', 'VERIFIED', 'MATCHED', 'INVESTIGATING', 'EXPLAINED', 'ESCALATED', 'COMPLETED', 'CANCELLED')),
  claim_id TEXT REFERENCES claims(id),
  verification TEXT,
  lookup_attempts INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  explanation TEXT CHECK(explanation IS NULL OR json_valid(explanation)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX calls_owner ON calls(user_id, created_at);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE REFERENCES calls(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  packet TEXT NOT NULL CHECK(json_valid(packet)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE jev_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  claim_id TEXT NOT NULL REFERENCES claims(id),
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  event TEXT NOT NULL,
  record_id TEXT NOT NULL,
  result TEXT NOT NULL,
  details TEXT NOT NULL CHECK(json_valid(details)),
  created_at TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL
) STRICT;
CREATE INDEX audit_owner ON audit_events(user_id, sequence);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
