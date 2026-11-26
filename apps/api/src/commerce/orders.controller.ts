import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Actor, CurrentActor, Db, Permit, Public, apiError } from '../core';
import { record, textField } from './pricing';
import { addTask, conflict, demoMode, json, missing, page, pageSize, uuid, validate, version } from './shared';

type Line = { id: string; order_id: string; quantity: string | null; quantity_source: string; version: number };
type SyncItem = {
  id: string;
  status: string;
  version: number;
  retryable: boolean;
  warehouse_ref: string | null;
};

export function batchStatus(items: { status: string }[]) {
  const statuses = items.map((i) => i.status);
  const succeeded = statuses.filter((s) => s === 'submitted' || s === 'tracking_updated').length;
  const failed = statuses.filter((s) => s === 'failed').length;
  const indeterminate = statuses.filter((s) => s === 'indeterminate' || s === 'needs_manual').length;
  const status = statuses.every((s) => s === 'queued')
    ? 'queued'
    : statuses.some((s) => s === 'queued' || s === 'submitting')
      ? 'running'
      : succeeded === statuses.length
        ? 'succeeded'
        : failed === statuses.length
          ? 'failed'
          : 'partial';
  return { status, total: statuses.length, succeeded, failed, indeterminate };
}

const orderColumns = Prisma.sql`o.id,o.fbpi_order_nr,o.mp_order_nr,o.currency,o.order_created_at,o.source,o.version,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'mp_item_nr',l.mp_item_nr,'partner_sku',l.partner_sku,
    'quantity',l.quantity::text,'quantity_source',l.quantity_source,'version',l.version,
    'sync_status',s.status,'sync_item_id',s.id,'batch_id',s.batch_id) ORDER BY l.mp_item_nr)
    FROM order_lines l LEFT JOIN sync_items s ON s.tenant_id=l.tenant_id AND s.line_id=l.id
    WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id),'[]'::jsonb) AS lines`;

@Controller()
export class OrdersController {
  constructor(private readonly db: Db) {}

  @Post('hooks/noon')
  @HttpCode(503)
  @Public()
  hook() {
    throw apiError(503, 'SOURCE_UNAVAILABLE', 'Noon 实际签名与店铺映射待沙箱确认');
  }

  @Post('dev/orders')
  @HttpCode(202)
  @Permit('orders.sync')
  demo(@CurrentActor() actor: Actor, @Headers('idempotency-key') key: string, @Body() raw: unknown) {
    if (!demoMode()) missing();
    const b = validate(() => record(raw ?? {}));
    return this.db.write(actor, key, 'dev.orders', b, async (tx) => {
      const orderNr =
        'DEMO-' +
        (b.order_nr === undefined
          ? randomUUID().slice(0, 12)
          : validate(() => textField(b.order_nr, 'order_nr', 64)));
      const eventId =
        b.message_id === null
          ? null
          : b.message_id === undefined
            ? randomUUID()
            : validate(() => textField(b.message_id, 'message_id', 128));
      const result = b.mock_result ?? 'accepted';
      if (!['accepted', 'timeout', 'no_query', 'retryable', 'fatal'].includes(String(result)))
        throw apiError(400, 'VALIDATION', 'mock_result 无效');
      const sample = { order_nr: orderNr, mock_result: result, metadata: { message_id: eventId } };
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO webhook_inbox (tenant_id,provider,event_id,event_type,order_nr,payload)
        VALUES (${actor.tid}::uuid,'dev_mock',${eventId},'FBPI::ORDER_SYNC',${orderNr},${json(sample)})
        ON CONFLICT(tenant_id,provider,event_id) DO NOTHING RETURNING id`;
      if (rows.length) await addTask(tx, actor.tid!, 'inbox', rows[0].id);
      return { source: 'dev_mock', received: true, duplicate: !rows.length, order_nr: orderNr };
    });
  }

  @Get('orders')
  @Permit('orders.read')
  orders(
    @CurrentActor() actor: Actor,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sku') sku?: string,
    @Query('status') status?: string,
  ) {
    const size = pageSize(limit);
    const seek = cursor
      ? Prisma.sql`AND (o.order_created_at,o.id)<(SELECT order_created_at,id FROM orders WHERE id=${uuid(cursor)}::uuid)`
      : Prisma.empty;
    const filter = sku
      ? Prisma.sql`AND EXISTS(SELECT 1 FROM order_lines l WHERE l.order_id=o.id AND l.partner_sku=${validate(() => textField(sku, 'sku'))})`
      : Prisma.empty;
    const stages = [
      'blocked_quantity',
      'ready',
      'queued',
      'submitting',
      'submitted',
      'failed',
      'indeterminate',
      'needs_manual',
      'tracking_updated',
    ];
    if (status && !stages.includes(status)) throw apiError(400, 'VALIDATION', '状态筛选无效');
    const state = status
      ? Prisma.sql`AND EXISTS(SELECT 1 FROM order_lines l LEFT JOIN sync_items i ON i.line_id=l.id WHERE l.order_id=o.id AND
      COALESCE(i.status,CASE WHEN l.quantity_source='unknown' THEN 'blocked_quantity' ELSE 'ready' END)=${status})`
      : Prisma.empty;
    return this.db.tenant(actor, async (tx) =>
      page(
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT ${orderColumns} FROM orders o WHERE true ${seek} ${filter} ${state}
      ORDER BY o.order_created_at DESC,o.id DESC LIMIT ${size + 1}`,
        size,
      ),
    );
  }

  @Get('orders/:id')
  @Permit('orders.read')
  order(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.db.tenant(actor, async (tx) => ({
      order:
        (
          await tx.$queryRaw<{ id: string }[]>`SELECT ${orderColumns} FROM orders o WHERE id=${uuid(id)}::uuid`
        )[0] ?? missing(),
    }));
  }

  @Patch('orders/:id/lines/:lineId')
  @Permit('orders.sync')
  quantity(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() raw: unknown,
  ) {
    const b = validate(() => record(raw));
    if (
      (typeof b.quantity !== 'number' && typeof b.quantity !== 'string') ||
      !/^\d{1,9}(?:\.\d{1,3})?$/.test(String(b.quantity)) ||
      Number(b.quantity) <= 0
    )
      throw apiError(422, 'VALIDATION', '数量须为正数，最多三位小数');
    const expected = version(b.version),
      qty = String(b.quantity);
    return this.db.tenant(actor, async (tx) => {
      const [line] = await tx.$queryRaw<
        Line[]
      >`SELECT id,quantity::text,version FROM order_lines WHERE id=${uuid(lineId)}::uuid AND order_id=${uuid(id)}::uuid FOR UPDATE`;
      if (!line) missing();
      if (line.version !== expected) conflict();
      const synced =
        (await tx.$queryRaw`SELECT id FROM sync_items WHERE line_id=${line.id}::uuid`) as unknown[];
      if (synced.length) throw apiError(409, 'ALREADY_SYNCING', '订单行已进入同步流程');
      await tx.$executeRaw`INSERT INTO order_quantity_audit(tenant_id,line_id,actor_id,old_quantity,new_quantity)
        VALUES(${actor.tid}::uuid,${line.id}::uuid,${actor.uid}::uuid,${line.quantity}::numeric,${qty}::numeric)`;
      const [updated] = await tx.$queryRaw<
        Line[]
      >`UPDATE order_lines SET quantity=${qty}::numeric,quantity_source='operator_confirmed',version=version+1
        WHERE id=${line.id}::uuid RETURNING id,quantity::text,quantity_source,version`;
      return { line: updated };
    });
  }

  @Post('sync-batches')
  @HttpCode(202)
  @Permit('orders.sync')
  batch(@CurrentActor() actor: Actor, @Headers('idempotency-key') key: string, @Body() raw: unknown) {
    const b = validate(() => record(raw));
    if (!Array.isArray(b.order_line_ids) || b.order_line_ids.length < 1 || b.order_line_ids.length > 50)
      throw apiError(422, 'VALIDATION', '每批须选 1 至 50 条订单行');
    const ids = b.order_line_ids.map(uuid).sort();
    if (new Set(ids).size !== ids.length) throw apiError(422, 'VALIDATION', '订单行重复');
    return this.db.write(actor, key, 'sync-batches.create', { order_line_ids: ids }, async (tx) => {
      const lines = await tx.$queryRaw<
        (Line & { source: string })[]
      >`SELECT l.id,l.order_id,l.quantity::text,l.quantity_source,o.source FROM order_lines l
        JOIN orders o ON o.id=l.order_id WHERE l.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY l.id FOR UPDATE OF l`;
      if (lines.length !== ids.length) missing();
      if (lines.some((l) => !l.quantity || l.quantity_source === 'unknown'))
        throw apiError(422, 'QUANTITY_UNKNOWN', '请先确认所有选中行的数量');
      if (!demoMode() || lines.some((l) => l.source !== 'dev_mock'))
        throw apiError(503, 'SOURCE_UNAVAILABLE', '中转仓连接尚未验证');
      const [batch] = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO sync_batches(tenant_id,created_by) VALUES(${actor.tid}::uuid,${actor.uid}::uuid) RETURNING id`;
      for (const l of lines) {
        const [item] = await tx.$queryRaw<
          { id: string }[]
        >`INSERT INTO sync_items(tenant_id,batch_id,order_id,line_id,quantity,status,adapter_key)
          VALUES(${actor.tid}::uuid,${batch.id}::uuid,${l.order_id}::uuid,${l.id}::uuid,${l.quantity}::numeric,'queued','dev_mock')
          ON CONFLICT(tenant_id,line_id) DO NOTHING RETURNING id`;
        if (!item) throw apiError(409, 'ALREADY_SYNCING', '选中行已存在同步记录');
        await addTask(tx, actor.tid!, 'sync', item.id);
      }
      return { batch: { id: batch.id, ...batchStatus(lines.map(() => ({ status: 'queued' }))) } };
    });
  }

  @Get('sync-batches/:id')
  @Permit('orders.read')
  status(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.db.tenant(actor, async (tx) => {
      const [batch] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id,created_at FROM sync_batches WHERE id=${uuid(id)}::uuid`;
      if (!batch) missing();
      const items = await tx.$queryRaw<
        SyncItem[]
      >`SELECT id,order_id,line_id,status,retryable,last_error,warehouse_ref,version,tracking
        FROM sync_items WHERE batch_id=${batch.id}::uuid ORDER BY id`;
      return { batch: { ...batch, ...batchStatus(items) }, items };
    });
  }

  @Post('sync-items/:id/retry')
  @HttpCode(202)
  @Permit('orders.sync')
  retry(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() raw: unknown,
  ) {
    return this.db.write(actor, key, 'sync-items.retry:' + uuid(id), raw ?? {}, async (tx) => {
      if (!demoMode()) throw apiError(503, 'SOURCE_UNAVAILABLE', '中转仓尚未验证');
      const [item] = await tx.$queryRaw<
        SyncItem[]
      >`UPDATE sync_items SET status='queued',retryable=false,version=version+1
        WHERE id=${id}::uuid AND adapter_key='dev_mock' AND status='failed' AND retryable RETURNING id,status,version`;
      if (!item) throw apiError(409, 'RETRY_FORBIDDEN', '该状态不可重试');
      await addTask(tx, actor.tid!, 'sync', id);
      return { item };
    });
  }

  @Post('sync-items/:id/manual')
  @Permit('orders.sync')
  manual(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() raw: unknown,
  ) {
    return this.db.write(actor, key, 'sync-items.manual:' + uuid(id), raw ?? {}, async (tx) => {
      const [item] = await tx.$queryRaw<
        SyncItem[]
      >`UPDATE sync_items SET status='needs_manual',retryable=false,version=version+1
        WHERE id=${id}::uuid AND status IN ('indeterminate','needs_manual') RETURNING id,status,version`;
      if (!item) throw apiError(409, 'INVALID_STATE', '当前状态不可转人工');
      return { item };
    });
  }

  @Patch('sync-items/:id/tracking')
  @Permit('orders.sync')
  tracking(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() raw: unknown) {
    const b = validate(() => record(raw)),
      expected = version(b.version);
    const tracking = validate(() => ({
      tracking_number: textField(b.tracking_number, 'tracking_number'),
      carrier: textField(b.carrier, 'carrier'),
      batch: b.batch === undefined ? null : textField(b.batch, 'batch'),
    }));
    return this.db.tenant(actor, async (tx) => {
      const [item] = await tx.$queryRaw<
        SyncItem[]
      >`UPDATE sync_items SET status='tracking_updated',tracking=${json(tracking)},version=version+1
        WHERE id=${uuid(id)}::uuid AND version=${expected} AND status IN ('submitted','tracking_updated') RETURNING id,status,version,tracking`;
      if (!item) conflict();
      return { item };
    });
  }
}
