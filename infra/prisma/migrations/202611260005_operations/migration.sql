CREATE TABLE queue_failures (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_failures_window ON queue_failures(tenant_id, occurred_at);
ALTER TABLE queue_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON queue_failures
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION record_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO queue_failures(tenant_id) VALUES (NEW.tenant_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER warehouse_failure AFTER INSERT ON sync_attempts
  FOR EACH ROW WHEN (NEW.result IN ('fatal','timeout','retryable')) EXECUTE FUNCTION record_queue_failure();
CREATE TRIGGER handler_failure AFTER UPDATE OF failures ON commerce_outbox
  FOR EACH ROW WHEN (NEW.failures > OLD.failures) EXECUTE FUNCTION record_queue_failure();
CREATE TRIGGER image_failure AFTER UPDATE OF status ON image_jobs
  FOR EACH ROW WHEN (NEW.status = 'failed' AND OLD.status <> 'failed') EXECUTE FUNCTION record_queue_failure();
