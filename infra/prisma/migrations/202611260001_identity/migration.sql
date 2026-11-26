CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  modules text[] NOT NULL DEFAULT ARRAY['orders','quotes','assets','reco','settings'],
  valid_until timestamptz, max_sessions int NOT NULL DEFAULT 2 CHECK (max_sessions > 0),
  version int NOT NULL DEFAULT 1
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants,
  email text NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  password_hash text, role text NOT NULL CHECK (role IN ('platform_admin','tenant_admin','tenant_member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  valid_until timestamptz, max_sessions int NOT NULL DEFAULT 2 CHECK (max_sessions > 0),
  deleted_at timestamptz, version int NOT NULL DEFAULT 1,
  CHECK ((role='platform_admin') = (tenant_id IS NULL))
);
CREATE INDEX ON users(tenant_id);
CREATE TABLE user_module_grants (
  user_id uuid NOT NULL REFERENCES users, module text NOT NULL
    CHECK(module IN ('orders','quotes','assets','reco','settings')), PRIMARY KEY(user_id,module)
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  tenant_id uuid REFERENCES tenants, refresh_token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX ON sessions(user_id,expires_at);
CREATE TABLE api_idempotency (
  actor_id uuid NOT NULL REFERENCES users, scope text NOT NULL, key text NOT NULL,
  fingerprint text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,scope,key)
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants,
  actor_id uuid REFERENCES users, action text NOT NULL, resource text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs(tenant_id,created_at);
CREATE TABLE break_glass_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  admin_id uuid NOT NULL REFERENCES users, authorized_by uuid NOT NULL REFERENCES users,
  reason text NOT NULL CHECK(reason IN ('support_ticket','incident_review','reconciliation')),
  permission text NOT NULL CHECK(permission IN ('orders.read','quotes.read','assets.read','reco.read')),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX ON break_glass_grants(tenant_id,admin_id,expires_at);
