CREATE TABLE shop_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  name text NOT NULL, fulfillment_mode text NOT NULL DEFAULT 'unknown'
    CHECK (fulfillment_mode IN ('unknown','fbpi','fbp','fbn')),
  creds_enc bytea NOT NULL, status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified','active','expired','error')),
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,name)
);
CREATE TABLE warehouse_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  vendor_name text NOT NULL, has_query boolean NOT NULL DEFAULT false,
  has_idempotency boolean NOT NULL DEFAULT false, creds_enc bytea,
  status text NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','active','expired','error')),
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,vendor_name)
);
ALTER TABLE shop_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_tenant ON shop_connections USING
  (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE warehouse_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_tenant ON warehouse_connections USING
  (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
