import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Db } from "../src/core";
import { readQueueSignals, shouldAlert } from "../src/operations";
test("T-OPS-02 queue alarm thresholds", () => {
  assert.equal(
    shouldAlert({ overdue_seconds: 300, failed_recently: 20 }),
    false,
  );
  assert.equal(shouldAlert({ overdue_seconds: 301, failed_recently: 1 }), true);
  assert.equal(shouldAlert({ overdue_seconds: 0, failed_recently: 21 }), true);
});
test(
  "T-OPS-02 database failures use a five-minute window and tenant-scoped queue age",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new Db(),
      id = randomUUID(),
      rollback = new Error("end fixture");
    try {
      await assert.rejects(
        db.client.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO tenants(id) VALUES (${id}::uuid)`;
          await db.context(tx, id);
          await tx.$executeRaw`INSERT INTO commerce_outbox(tenant_id,topic,resource_id,next_attempt_at)
        VALUES(${id}::uuid,'inbox',gen_random_uuid(),now()-interval '6 minutes')`;
          await tx.$executeRaw`UPDATE commerce_outbox SET failures=1 WHERE tenant_id=${id}::uuid`;
          await tx.$executeRaw`INSERT INTO queue_failures(tenant_id,occurred_at) VALUES(${id}::uuid,now()-interval '6 minutes')`;
          const signals = await readQueueSignals(tx);
          assert.ok(signals.overdue_seconds >= 360);
          assert.equal(signals.failed_recently, 1);
          assert.ok(shouldAlert(signals));
          throw rollback;
        }),
        (error) => error === rollback,
      );
    } finally {
      await db.client.$disconnect();
    }
  },
);
