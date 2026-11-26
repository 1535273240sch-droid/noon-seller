CREATE TABLE upload_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  s3_key text NOT NULL UNIQUE,
  sha256 text NOT NULL, bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 10485760),
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
  copyright_ack_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256), UNIQUE (tenant_id, id)
);

CREATE TABLE image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL, pipeline jsonb NOT NULL, options jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','processing','succeeded_pending_review','failed','indeterminate','confirmed','discarded')),
  version integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  output_key text, provider_job_ref text, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,source_id) REFERENCES upload_objects(tenant_id,id)
);
CREATE INDEX image_jobs_due ON image_jobs (tenant_id,status,next_attempt_at,created_at);
CREATE TABLE quota_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id), balance integer NOT NULL CHECK (balance >= 0)
);
CREATE TABLE quota_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL, entry_type text NOT NULL CHECK (entry_type IN ('reserve','consume','release')),
  qty integer NOT NULL CHECK (qty = 1), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,entry_type), FOREIGN KEY (tenant_id,job_id) REFERENCES image_jobs(tenant_id,id)
);
CREATE INDEX quota_ledger_tenant ON quota_ledger(tenant_id,created_at);
CREATE UNIQUE INDEX quota_one_settlement ON quota_ledger(job_id) WHERE entry_type IN ('consume','release');
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL UNIQUE, object_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('white','scene','callout','collage')),
  simulated boolean NOT NULL DEFAULT false, reviewed_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,job_id) REFERENCES image_jobs(tenant_id,id)
);
CREATE INDEX assets_tenant ON assets(tenant_id,approved_at);

CREATE TABLE reco_sources (
  adapter_key text PRIMARY KEY CHECK (adapter_key <> 'own_shop_sales'),
  simulated boolean NOT NULL, label text NOT NULL
);
CREATE TABLE reco_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text NOT NULL REFERENCES reco_sources(adapter_key),
  fetched_at timestamptz NOT NULL, tz text NOT NULL, content_hash text NOT NULL,
  UNIQUE(source_id,content_hash), UNIQUE(source_id,id)
);
CREATE TABLE reco_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_id uuid NOT NULL, source_id text NOT NULL,
  external_id text NOT NULL, time_bucket date NOT NULL, title text NOT NULL, category text NOT NULL,
  site text NOT NULL, price numeric(14,2) NOT NULL, currency text NOT NULL,
  image_url text, sales_or_rank numeric,
  FOREIGN KEY(source_id,snapshot_id) REFERENCES reco_snapshots(source_id,id),
  UNIQUE(source_id,external_id,time_bucket)
);
CREATE INDEX reco_items_snapshot ON reco_items(snapshot_id);
CREATE TABLE reco_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id), filters jsonb NOT NULL, frequency text NOT NULL,
  tz text NOT NULL, dnd_start time, dnd_end time, version integer NOT NULL DEFAULT 1,
  next_run_at timestamptz NOT NULL DEFAULT now(), unsubscribed_at timestamptz
);
CREATE INDEX reco_subscriptions_due ON reco_subscriptions(tenant_id,next_run_at) WHERE unsubscribed_at IS NULL;
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id), item_id uuid NOT NULL REFERENCES reco_items(id),
  payload jsonb NOT NULL, quiet boolean NOT NULL, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,item_id)
);
CREATE INDEX notifications_inbox ON notifications(tenant_id,user_id,created_at);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['upload_objects','image_jobs','quota_accounts','quota_ledger','assets','reco_subscriptions','notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
