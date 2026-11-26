CREATE TABLE pricing_rules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL, rule jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,name)
);
CREATE TABLE fx_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL, base text NOT NULL, quote text NOT NULL,
  rate numeric(28,12) NOT NULL CHECK (rate > 0), fetched_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id)
);
CREATE INDEX fx_recent ON fx_snapshots(tenant_id,base,quote,fetched_at DESC);
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  rule_id uuid NOT NULL, rule_version integer NOT NULL, fx_snapshot_id uuid NOT NULL,
  sku text NOT NULL, inputs jsonb NOT NULL, breakdown jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES pricing_rules(tenant_id,id),
  FOREIGN KEY (tenant_id,fx_snapshot_id) REFERENCES fx_snapshots(tenant_id,id)
);
CREATE INDEX quotes_history ON quotes(tenant_id,sku,created_at DESC,id DESC);
CREATE TABLE quote_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id), filter_sku text, content bytea, status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  fbpi_order_nr text NOT NULL, mp_order_nr text, currency text, raw_snapshot jsonb NOT NULL,
  order_created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  source text NOT NULL CHECK (source IN ('dev_mock','noon')),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,fbpi_order_nr)
);
CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, order_id uuid NOT NULL,
  mp_item_nr text NOT NULL, partner_sku text NOT NULL, quantity numeric(12,3),
  quantity_source text NOT NULL DEFAULT 'unknown' CHECK (quantity_source IN ('unknown','operator_confirmed','noon_field')),
  version integer NOT NULL DEFAULT 1,
  CHECK ((quantity IS NULL AND quantity_source='unknown') OR (quantity IS NOT NULL AND quantity > 0 AND quantity_source<>'unknown')),
  FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,mp_item_nr), UNIQUE(tenant_id,order_id,id)
);
CREATE INDEX order_lines_parent ON order_lines(tenant_id,order_id);
CREATE TABLE sync_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE sync_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, batch_id uuid NOT NULL,
  order_id uuid NOT NULL, line_id uuid NOT NULL, quantity numeric(12,3) NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','submitting','submitted','failed','indeterminate','needs_manual','tracking_updated')),
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, adapter_key text NOT NULL,
  warehouse_ref text, last_error text, retryable boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  tracking jsonb, UNIQUE(tenant_id,id), UNIQUE(tenant_id,line_id),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES sync_batches(tenant_id,id),
  FOREIGN KEY (tenant_id,order_id,line_id) REFERENCES order_lines(tenant_id,order_id,id)
);
CREATE INDEX sync_items_batch ON sync_items(tenant_id,batch_id);
CREATE TABLE sync_attempts (
  tenant_id uuid NOT NULL, item_id uuid NOT NULL, attempt_no integer NOT NULL,
  result text NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,item_id,attempt_no), FOREIGN KEY (tenant_id,item_id) REFERENCES sync_items(tenant_id,id)
);
CREATE TABLE webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL, event_id text, event_type text NOT NULL, order_nr text NOT NULL,
  payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error_code text,
  UNIQUE(tenant_id,provider,event_id)
);
CREATE TABLE commerce_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  topic text NOT NULL CHECK (topic IN ('sync','inbox','export')), resource_id uuid NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0, last_error text,
  UNIQUE (tenant_id,topic,resource_id)
);
CREATE INDEX commerce_pending ON commerce_outbox(tenant_id,next_attempt_at) WHERE finished_at IS NULL;
CREATE TABLE order_quantity_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, line_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id), old_quantity numeric(12,3), new_quantity numeric(12,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (tenant_id,line_id) REFERENCES order_lines(tenant_id,id)
);
DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pricing_rules','fx_snapshots','quotes','quote_exports','orders','order_lines',
      'sync_batches','sync_items','sync_attempts','webhook_inbox','commerce_outbox','order_quantity_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_ownership ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
    EXECUTE format('CREATE INDEX %I ON %I(tenant_id)',t || '_rls',t);
  END LOOP;
END
$policies$;
