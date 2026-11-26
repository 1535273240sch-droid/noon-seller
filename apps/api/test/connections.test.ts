import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Actor, Db } from "../src/core";
import { ConnectionsController } from "../src/identity/connections.controller";
import { readCredentials, storeCredentials } from "../src/identity/envelope";

process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString("base64");
test("credential envelopes authenticate the tenant and connection, use fresh encryption keys", () => {
  const credentials = { secret: "demo-test-secret" },
    context = "tenant/shop/id";
  const first = storeCredentials(credentials, context),
    second = storeCredentials(credentials, context);
  assert.notDeepEqual(first, second);
  assert.deepEqual(readCredentials(first, context), credentials);
  assert.throws(() => readCredentials(first, "other/shop/id"));
  first[first.length - 1] ^= 1;
  assert.throws(() => readCredentials(first, context));
});

test(
  "A-SET-01–03 record-only provider capabilities, isolated encrypted credentials and rotation",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new Db(),
      controller = new ConnectionsController(db);
    t.after(() => db.onModuleDestroy());
    async function account(): Promise<Actor> {
      const tenant = await db.client.tenant.create({
        data: { modules: ["settings"] },
      });
      const user = await db.client.user.create({
        data: {
          tenantId: tenant.id,
          role: "tenant_admin",
          email: randomUUID() + "@test.invalid",
        },
      });
      return {
        tid: tenant.id,
        uid: user.id,
        role: "tenant_admin",
        permissions: ["settings.read", "settings.write"],
        sid: randomUUID(),
      };
    }
    const actor = await account(),
      other = await account(),
      credentials = { private_key: "fixture-one" };
    const { shop } = await controller.createShop(actor, "create", {
      name: "test shop",
      fulfillment_mode: "fbpi",
      credentials,
    });
    assert.equal(shop.status, "unverified");
    assert.deepEqual((await controller.list(other)).shops, []);
    assert.ok(
      !JSON.stringify(await controller.list(actor)).includes("private_key"),
    );
    await assert.rejects(
      controller.verify(actor, "verify", shop.id),
      (e: { getStatus(): number }) => e.getStatus() === 503,
    );
    const updated = await controller.rotateShop(actor, "rotate", shop.id, {
      version: 1,
      credentials: { private_key: "fixture-two" },
    });
    assert.equal(updated.shop.version, 2);
    assert.equal(updated.provider_revocation, "unverified");
    const [row] = await db.tenant(
      actor,
      (tx) =>
        tx.$queryRaw<
          Array<{ creds_enc: Uint8Array }>
        >`SELECT creds_enc FROM shop_connections WHERE id=${shop.id}::uuid`,
    );
    assert.deepEqual(
      readCredentials(row.creds_enc, actor.tid + "/shop/" + shop.id),
      { private_key: "fixture-two" },
    );
    await assert.rejects(
      controller.rotateShop(actor, "stale", shop.id, {
        version: 1,
        credentials,
      }),
    );
    await assert.rejects(
      controller.rotateShop(other, "cross-tenant", shop.id, {
        version: 2,
        credentials,
      }),
    );
    const { warehouse } = await controller.warehouse(actor, "warehouse", {
      vendor_name: "test warehouse",
    });
    assert.equal(warehouse.has_query, false);
    const saved = await controller.capabilities(actor, warehouse.id, {
      version: 1,
      has_query: true,
      has_idempotency: true,
    });
    assert.equal(saved.warehouse.status, "unverified");
    assert.equal(saved.warehouse.has_query, true);
  },
);
