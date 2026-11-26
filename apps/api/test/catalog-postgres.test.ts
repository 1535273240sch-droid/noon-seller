import "reflect-metadata";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Actor, Db } from "../src/core";
import { Images } from "../src/catalog/images.service";
import { ObjectStore } from "../src/catalog/objects";
import { Recommendations } from "../src/catalog/recommendations.service";

class MemoryStore {
  files = new Map<string, Buffer>();
  rejectReads = false;
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const blob = this.files.get(key);
    if (this.rejectReads || !blob) throw new Error("read failed");
    return blob;
  }
  async link(path: string) {
    return { url: "test-signed:" + path, expires_in: 300 };
  }
}

// Use a migrated, dedicated scratch PostgreSQL database via an application role subject to RLS.
test(
  "F4/F5 PostgreSQL 事务、隔离与后台恢复",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const previous = {
      url: process.env.DATABASE_URL,
      app: process.env.APP_ENV,
      node: process.env.NODE_ENV,
      quota: process.env.IMAGE_INITIAL_QUOTA,
    };
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.APP_ENV = "dev";
    process.env.NODE_ENV = "test";
    process.env.IMAGE_INITIAL_QUOTA = "5";
    const db = new Db();
    const store = new MemoryStore();
    const images = new Images(db, store as unknown as ObjectStore);
    const reco = new Recommendations(db);
    const actors: Actor[] = [];
    t.after(async () => {
      try {
        for (const a of actors)
          await db.tenant(a, async (tx) => {
            await tx.$executeRaw`DELETE FROM queue_failures WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM notifications WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM reco_subscriptions WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM assets WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM quota_ledger WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM image_jobs WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM quota_accounts WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM upload_objects WHERE tenant_id=${a.tid}::uuid`;
            await tx.$executeRaw`DELETE FROM api_idempotency WHERE actor_id=${a.uid}::uuid`;
            await tx.$executeRaw`DELETE FROM users WHERE id=${a.uid}::uuid`;
            await tx.$executeRaw`DELETE FROM tenants WHERE id=${a.tid}::uuid`;
          });
      } finally {
        await db.onModuleDestroy();
        for (const [key, value] of Object.entries({
          DATABASE_URL: previous.url,
          APP_ENV: previous.app,
          NODE_ENV: previous.node,
          IMAGE_INITIAL_QUOTA: previous.quota,
        }))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    });
    const [runtime] = await db.client.$queryRaw<
      { privileged: boolean }[]
    >`SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname=current_user`;
    assert.equal(
      runtime.privileged,
      false,
      "TEST_DATABASE_URL must use a role subject to row-level security",
    );
    for (let i = 0; i < 2; i++) {
      const actor: Actor = {
        uid: randomUUID(),
        tid: randomUUID(),
        sid: randomUUID(),
        permissions: [],
        role: "tenant_admin",
      };
      await db.client.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants(id) VALUES(${actor.tid}::uuid)`;
        await tx.$executeRaw`INSERT INTO users(id,tenant_id,email,role) VALUES(${actor.uid}::uuid,${actor.tid}::uuid,
        ${actor.uid + "@example.invalid"},'tenant_admin')`;
      });
      actors.push(actor);
    }
    const [a, b] = actors;
    const image = await sharp({
      create: { width: 50, height: 60, channels: 3, background: "#89abcd" },
    })
      .png()
      .toBuffer();
    const upload = await images.upload(a, randomUUID(), {
      mime: "image/png",
      file_base64: image.toString("base64"),
      copyright_ack: true,
    });
    const body = { source_id: upload.source_id, pipeline: ["resize"] };
    const code = (expected: string) => (e: any) =>
      e?.getResponse?.().error.code === expected;
    await t.test(
      "T-F4-01/03/05 重复提交和多 worker 只消费一次，待审图片无法作为其他租户素材下载",
      async () => {
        const key = randomUUID();
        const [job, duplicate] = await Promise.all([
          images.create(a, key, body),
          images.create(a, key, body),
        ]);
        assert.equal(duplicate.job_id, job.job_id);
        assert.equal((await images.quota(a)).balance, 4);
        assert.deepEqual((await images.list(a)).data, []);
        await Promise.all([images.processOne(a), images.processOne(a)]);
        const state = await images.show(a, job.job_id);
        assert.equal(state.job.status, "succeeded_pending_review");
        assert.deepEqual(
          state.quota_ledger.map((row) => row.entry_type).sort(),
          ["consume", "reserve"],
        );
        await assert.rejects(
          images.review(a, job.job_id, randomUUID(), { version: 1 }, true),
          code("VERSION_CONFLICT"),
        );
        const saved = await images.review(
          a,
          job.job_id,
          randomUUID(),
          { version: state.job.version },
          true,
        );
        assert.ok(saved.asset_id);
        assert.equal(
          (await images.download(a, saved.asset_id!)).expires_in,
          300,
        );
        await assert.rejects(
          images.download(b, saved.asset_id!),
          code("FORBIDDEN"),
        );
        await assert.rejects(images.show(b, job.job_id), code("NOT_FOUND"));
        await assert.rejects(
          db.tenant(
            a,
            (
              tx,
            ) => tx.$executeRaw`INSERT INTO quota_ledger(tenant_id,job_id,entry_type,qty)
      VALUES(${a.tid}::uuid,${job.job_id}::uuid,'release',1)`,
          ),
        );
      },
    );
    await t.test("T-F4-02 确定失败后恢复预占余额", async () => {
      const job = await images.create(a, randomUUID(), body);
      store.rejectReads = true;
      await db.tenant(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE image_jobs SET attempts=2 WHERE id=${job.job_id}::uuid`,
      );
      await images.processOne(a);
      store.rejectReads = false;
      const state = await images.show(a, job.job_id);
      assert.equal(state.job.status, "failed");
      assert.deepEqual(state.quota_ledger.map((row) => row.entry_type).sort(), [
        "release",
        "reserve",
      ]);
      assert.equal((await images.quota(a)).balance, 4);
    });
    await t.test("T-F4-04 结果不明不重新执行或扣费", async () => {
      const job = await images.create(a, randomUUID(), body);
      await db.tenant(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE image_jobs SET status='indeterminate' WHERE id=${job.job_id}::uuid`,
      );
      await images.processOne(a);
      const state = await images.show(a, job.job_id);
      assert.equal(state.job.status, "indeterminate");
      assert.deepEqual(
        state.quota_ledger.map((row) => row.entry_type),
        ["reserve"],
      );
    });
    await t.test(
      "T-F5-01/04 过滤、免打扰入箱、去重、跨用户隔离和退订",
      async () => {
        const clock = (offset: number) =>
          new Date(Date.now() + offset * 60000).toISOString().slice(11, 16);
        const input = {
          tz: "UTC",
          frequency: "hourly",
          filters: { site: "AE", max_price: 20 },
          dnd_start: clock(-2),
          dnd_end: clock(2),
        };
        const sub = await reco.save(a, input);
        const result = await reco.list(a, input.filters);
        assert.equal(result.data.length, 1);
        assert.equal(result.source.simulated, true);
        await Promise.all([reco.dispatch(a), reco.dispatch(a)]);
        const messages = (await reco.inbox(a)).data;
        assert.equal(messages.length, 1);
        assert.equal(messages[0].quiet, true);
        assert.equal(messages[0].payload.simulated, true);
        await assert.rejects(reco.read(b, messages[0].id), code("NOT_FOUND"));
        assert.ok((await reco.read(a, messages[0].id)).read_at);
        await assert.rejects(reco.save(a, input), code("VERSION_CONFLICT"));
        await reco.save(a, { ...input, version: sub.version, filters: {} });
        await reco.unsubscribe(a, randomUUID());
        await reco.dispatch(a);
        assert.equal((await reco.inbox(a)).data.length, 1);
      },
    );
  },
);
