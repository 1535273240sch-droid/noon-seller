import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Actor, Db } from '../src/core';
import { OrdersController } from '../src/commerce/orders.controller';
import { QuotesController } from '../src/commerce/quotes.controller';
import { CommerceWorker } from '../src/commerce/worker';

const matches = (code: string) => (e: unknown) =>
  e instanceof HttpException && (e.getResponse() as { error: { code: string } }).error.code === code;

test('PostgreSQL 商务流程', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const originalUrl = process.env.DATABASE_URL,
    originalEnv = process.env.APP_ENV;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.APP_ENV = 'dev';
  const db = new Db(),
    orders = new OrdersController(db),
    quotes = new QuotesController(db);
  const workers = [new CommerceWorker(db), new CommerceWorker(db)];
  const actor: Actor = {
    uid: randomUUID(),
    tid: randomUUID(),
    role: 'tenant_admin',
    permissions: [],
    sid: randomUUID(),
  };
  const other: Actor = { ...actor, uid: randomUUID(), tid: randomUUID() };
  // Disabled test tenants keep a running server's scheduler out of the recovery scenario.
  // These tests invoke the controllers after identity authorization, which has its own suite.
  try {
    for (const a of [actor, other]) {
      await db.client.$executeRaw`INSERT INTO tenants(id,status) VALUES(${a.tid}::uuid,'disabled')`;
      await db.client
        .$executeRaw`INSERT INTO users(id,tenant_id,email,role) VALUES(${a.uid}::uuid,${a.tid}::uuid,${a.uid + '@example.invalid'},'tenant_admin')`;
    }
    await t.test('T-F1-01/02/04/05/07 重放事件、确认数量、并发重复请求、换 worker 恢复', async () => {
      const event = { order_nr: 'first', message_id: randomUUID() };
      const receipt = await orders.demo(actor, randomUUID(), event);
      assert.equal(receipt.duplicate, false);
      assert.equal((await orders.demo(actor, randomUUID(), event)).duplicate, true);
      assert.equal(
        (await orders.demo(actor, randomUUID(), { ...event, message_id: randomUUID() })).duplicate,
        false,
      );
      await workers[0].drainTenant(actor.tid!);
      const rows = (await orders.orders(actor)).data as {
        id: string;
        version: number;
        lines: { id: string; version: number; quantity: string | null }[];
      }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].version, 2);
      const lines = rows[0].lines,
        ids = lines.map((l) => l.id);
      assert.equal(lines.length, 3);
      assert(lines.every((l) => l.quantity === null));
      await assert.rejects(
        orders.batch(actor, randomUUID(), { order_line_ids: ids }),
        matches('QUANTITY_UNKNOWN'),
      );
      await assert.rejects(orders.order(other, rows[0].id), matches('NOT_FOUND'));
      for (const l of lines)
        await orders.quantity(actor, rows[0].id, l.id, { version: l.version, quantity: '1.250' });
      const key = randomUUID();
      const [one, two] = await Promise.all([1, 2].map(() => orders.batch(actor, key, { order_line_ids: ids })));
      assert.equal(one.batch.id, two.batch.id);
      await assert.rejects(
        orders.batch(actor, key, { order_line_ids: [ids[0]] }),
        matches('IDEMPOTENCY_CONFLICT'),
      );
      await Promise.all(workers.map((w) => w.drainTenant(actor.tid!)));
      const completed = await orders.status(actor, one.batch.id);
      assert.equal(completed.batch.succeeded, 3);
      assert(completed.items.every((i) => i.warehouse_ref?.startsWith('DEMO-WH-')));
      await workers[1].drainTenant(actor.tid!);
      const [n] = await db.tenant(
        actor,
        (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM sync_attempts`,
      );
      assert.equal(n.n, 3);
    });
    await t.test('T-F1-06 超时结果禁止重试，缺仓库查单转人工', async () => {
      await orders.demo(actor, randomUUID(), { order_nr: 'timeout', mock_result: 'no_query' });
      await workers[0].drainTenant(actor.tid!);
      const list = (await orders.orders(actor)).data as {
        id: string;
        fbpi_order_nr: string;
        lines: { id: string; version: number }[];
      }[];
      const order = list.find((o) => o.fbpi_order_nr === 'DEMO-timeout')!,
        l = order.lines[0];
      await orders.quantity(actor, order.id, l.id, { version: l.version, quantity: '2' });
      const result = await orders.batch(actor, randomUUID(), { order_line_ids: [l.id] });
      await workers[0].drainTenant(actor.tid!);
      const [item] = (await orders.status(actor, result.batch.id)).items;
      assert.equal(item.status, 'indeterminate');
      await assert.rejects(orders.retry(actor, item.id, randomUUID(), {}), matches('RETRY_FORBIDDEN'));
      await db.tenant(
        actor,
        (tx) =>
          tx.$executeRaw`UPDATE commerce_outbox SET next_attempt_at=now() WHERE resource_id=${item.id}::uuid`,
      );
      await workers[1].drainTenant(actor.tid!);
      assert.equal((await orders.status(actor, result.batch.id)).items[0].status, 'needs_manual');
    });
    await t.test('T-F2-01/05 版本冲突、快照、真实 XLSX 导出与过期', async () => {
      const id = randomUUID(),
        rule = {
          objective: 'target_margin_on_price',
          tax_mode: 'tax_on_price',
          commission_rate: '0.1',
          tax_rate: '0.05',
          target_rate: '0.2',
          rate_card: { first_weight_kg: 1, first_fee: 10, step_weight_kg: 1, step_fee: 0 },
        };
      await quotes.rule(actor, id, { ...rule, name: '测试', version: 0 });
      await assert.rejects(
        quotes.rule(actor, id, { ...rule, name: '测试', version: 0 }),
        matches('VERSION_CONFLICT'),
      );
      const input = {
        rule_id: id,
        rule_version: 1,
        sku: 'SKU-X',
        weight_kg: 1,
        purchase_cost: 50,
        fx: { provider: 'manual', rate: 0.5, base: 'CNY', quote: 'AED', fetched_at: new Date().toISOString() },
      };
      const saved = await quotes.save(actor, randomUUID(), input);
      assert.equal(saved.quote.selling_price, '46.15');
      const job = await quotes.export(actor, randomUUID(), { sku: 'SKU-X' });
      await workers[1].drainTenant(actor.tid!);
      assert.equal((await quotes.exportStatus(actor, job.job_id)).status, 'ready');
      await assert.rejects(quotes.exportStatus(other, job.job_id), matches('NOT_FOUND'));
      const [r] = await db.tenant(
        actor,
        (tx) =>
          tx.$queryRaw<
            { content: Uint8Array }[]
          >`SELECT content FROM quote_exports WHERE id=${job.job_id}::uuid`,
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(r.content) as Parameters<typeof wb.xlsx.load>[0]);
      assert.equal(wb.worksheets[0].getCell('A2').value, 'SKU-X');
      assert.equal(wb.worksheets[0].getCell('D2').value, '46.15');
      await db.tenant(
        actor,
        (tx) => tx.$executeRaw`UPDATE quote_exports SET expires_at=now() WHERE id=${job.job_id}::uuid`,
      );
      await workers[0].drainTenant(actor.tid!);
      assert.equal((await quotes.exportStatus(actor, job.job_id)).status, 'expired');
    });
  } finally {
    for (const a of [actor, other]) {
      await db.tenant(a, async (tx) => {
        const tables = [
          'queue_failures',
          'order_quantity_audit',
          'sync_attempts',
          'sync_items',
          'sync_batches',
          'order_lines',
          'orders',
          'webhook_inbox',
          'commerce_outbox',
          'quotes',
          'pricing_rules',
          'fx_snapshots',
          'quote_exports',
        ];
        for (const table of tables)
          await tx.$executeRawUnsafe('DELETE FROM ' + table + ' WHERE tenant_id=$1::uuid', a.tid);
        await tx.$executeRaw`DELETE FROM api_idempotency WHERE actor_id=${a.uid}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE id=${a.uid}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id=${a.tid}::uuid`;
      });
    }
    await db.client.$disconnect();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv;
  }
});
