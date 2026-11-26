import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import ExcelJS from 'exceljs';
import { Db, Tx } from '../core';
import { developmentOrder, developmentWarehouse } from './adapters';
import { demoMode, json } from './shared';

type Task = {
  id: string;
  topic: 'sync' | 'inbox' | 'export';
  resource_id: string;
  attempts: number;
  tenant_id: string;
};
type Item = {
  status: string;
  adapter_key: string;
  idempotency_key: string;
  quantity: string;
  partner_sku: string;
  mock_result: string | null;
};
const backoff = [15, 60, 240];

async function processInbox(tx: Tx, task: Task) {
  const [row] = await tx.$queryRaw<
    { provider: string; order_nr: string; payload: Record<string, unknown> }[]
  >`SELECT provider,order_nr,payload FROM webhook_inbox WHERE id=${task.resource_id}::uuid FOR UPDATE`;
  if (!row) return;
  if (row.provider !== 'dev_mock' || !demoMode()) {
    await tx.$executeRaw`UPDATE webhook_inbox SET error_code='SOURCE_UNAVAILABLE' WHERE id=${task.resource_id}::uuid`;
    return;
  }
  const snapshot = developmentOrder(row.order_nr);
  const [order] = await tx.$queryRaw<
    { id: string }[]
  >`INSERT INTO orders(tenant_id,fbpi_order_nr,mp_order_nr,currency,raw_snapshot,source)
    VALUES(${task.tenant_id}::uuid,${snapshot.fbpi_order_nr},${snapshot.mp_order_nr},${snapshot.currency},${json({ ...snapshot, mock_result: row.payload.mock_result })},'dev_mock')
    ON CONFLICT(tenant_id,fbpi_order_nr) DO UPDATE SET raw_snapshot=excluded.raw_snapshot,version=orders.version+1 RETURNING id`;
  for (const l of snapshot.items) {
    await tx.$executeRaw`INSERT INTO order_lines(tenant_id,order_id,mp_item_nr,partner_sku)
      VALUES(${task.tenant_id}::uuid,${order.id}::uuid,${l.mp_item_nr},${l.partner_sku})
      ON CONFLICT(tenant_id,mp_item_nr) DO UPDATE SET partner_sku=excluded.partner_sku`;
  }
  await tx.$executeRaw`UPDATE webhook_inbox SET processed_at=now() WHERE id=${task.resource_id}::uuid`;
}

async function processItem(tx: Tx, task: Task): Promise<number | null> {
  const id = task.resource_id;
  const [item] = await tx.$queryRaw<
    Item[]
  >`SELECT s.status,s.adapter_key,s.idempotency_key,s.quantity::text,l.partner_sku,o.raw_snapshot->>'mock_result' AS mock_result
    FROM sync_items s JOIN orders o ON o.id=s.order_id JOIN order_lines l ON l.id=s.line_id
    WHERE s.id=${id}::uuid FOR UPDATE OF s`;
  if (!item || !['queued', 'indeterminate'].includes(item.status)) return null;
  if (!demoMode() || item.adapter_key !== 'dev_mock') {
    await tx.$executeRaw`UPDATE sync_items SET status='needs_manual',retryable=false,last_error='SOURCE_UNAVAILABLE',version=version+1 WHERE id=${id}::uuid`;
    return null;
  }
  const adapter = developmentWarehouse(item.mock_result ?? 'accepted', task.attempts + 1);
  if (item.status === 'indeterminate') {
    const lookup = adapter.hasQuery
      ? await adapter.query(item.idempotency_key)
      : ({ state: 'unknown' } as const);
    const confirmed = lookup.state === 'accepted';
    await tx.$executeRaw`UPDATE sync_items SET status=${confirmed ? 'submitted' : 'needs_manual'},warehouse_ref=${lookup.state === 'accepted' ? lookup.ref : null},
      retryable=false,last_error=${confirmed ? null : 'QUERY_UNAVAILABLE'},version=version+1 WHERE id=${id}::uuid`;
    return null;
  }
  const result = await adapter.submit({
    idempotencyKey: item.idempotency_key,
    quantity: item.quantity,
    sku: item.partner_sku,
  });
  const attempt = task.attempts + 1;
  await tx.$executeRaw`INSERT INTO sync_attempts(tenant_id,item_id,attempt_no,result) VALUES(${task.tenant_id}::uuid,${id}::uuid,${attempt},${result.type})`;
  const retryable = result.type === 'retryable' && adapter.hasQuery && adapter.hasIdempotency;
  const retry = retryable && attempt <= backoff.length;
  const status =
    result.type === 'accepted'
      ? 'submitted'
      : result.type === 'timeout'
        ? 'indeterminate'
        : retry
          ? 'queued'
          : 'failed';
  await tx.$executeRaw`UPDATE sync_items SET status=${status},retryable=${retryable && !retry},warehouse_ref=${result.type === 'accepted' ? result.ref : null},
    last_error=${result.type === 'accepted' ? null : result.type},version=version+1 WHERE id=${id}::uuid`;
  return status === 'indeterminate' ? 15 : retry ? backoff[attempt - 1] : null;
}

async function processExport(tx: Tx, task: Task) {
  const [job] = await tx.$queryRaw<
    { filter_sku: string | null }[]
  >`SELECT filter_sku FROM quote_exports WHERE id=${task.resource_id}::uuid FOR UPDATE`;
  if (!job) return;
  const filter = job.filter_sku ? Prisma.sql`WHERE sku=${job.filter_sku}` : Prisma.empty;
  type Quote = { sku: string; breakdown: Record<string, string | null>; created_at: Date };
  const rows = await tx.$queryRaw<
    Quote[]
  >`SELECT sku,breakdown,created_at FROM quotes ${filter} ORDER BY created_at,id`;
  const workbook = new ExcelJS.Workbook();
  let sheet = workbook.addWorksheet('报价 1');
  let n = 1;
  const heading = ['SKU', '币种', '到岸成本', '售价', '佣金', '税', '利润', '实现毛利率', '报价时间 (UTC)'];
  sheet.addRow(heading);
  for (const { sku, breakdown: q, created_at } of rows) {
    if (sheet.rowCount === 1048576) {
      sheet = workbook.addWorksheet('报价 ' + ++n);
      sheet.addRow(heading);
    }
    sheet.addRow([
      sku,
      q.currency,
      q.landed_cost,
      q.selling_price,
      q.commission,
      q.tax,
      q.implied_profit,
      q.implied_margin,
      created_at.toISOString(),
    ]);
  }
  for (const ws of workbook.worksheets) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c, i) => {
      c.width = i === 0 || i === 8 ? 30 : 16;
    });
  }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  await tx.$executeRaw`UPDATE quote_exports SET content=${bytes},status='ready',expires_at=now()+interval '5 minutes' WHERE id=${task.resource_id}::uuid`;
}

@Injectable()
export class CommerceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private queue?: Queue;
  private worker?: Worker;
  private retrySchedule?: NodeJS.Timeout;
  private localTimer?: NodeJS.Timeout;
  private localRun?: Promise<void>;
  private stopping = false;
  private readonly logger = new Logger('CommerceWorker');
  constructor(private readonly db: Db) {}

  onApplicationBootstrap() {
    if (!process.env.REDIS_URL) {
      const testEnvironment =
        process.env.NODE_ENV === 'test' && !['staging', 'prod'].includes(process.env.APP_ENV ?? '');
      if (!demoMode() && !testEnvironment) throw new Error('REDIS_URL is required');
      this.logger.log('Local development poller processes the PostgreSQL outbox');
      this.scheduleLocalDrain();
      return;
    }
    const url = new URL(process.env.REDIS_URL);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid REDIS_URL');
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
      db: Number(url.pathname.slice(1) || 0),
      tls: url.protocol === 'rediss:' ? {} : undefined,
    };
    const name = 'noon-commerce-' + (process.env.APP_ENV || 'dev');
    this.queue = new Queue(name, { connection });
    this.worker = new Worker(name, async () => this.drain(), { connection });
    this.queue.on('error', () => this.logger.error('Commerce Redis queue unavailable'));
    this.worker.on('error', () => this.logger.error('Commerce worker connection unavailable'));
    this.worker.on('failed', () =>
      this.logger.error('Commerce worker tick failed; pending outbox rows will be retried'),
    );
    void this.registerSchedule();
  }
  private scheduleLocalDrain() {
    if (this.stopping) return;
    this.localTimer = setTimeout(() => {
      this.localRun = this.drain()
        .catch(() => this.logger.error('Local outbox poll failed'))
        .finally(() => this.scheduleLocalDrain());
    }, 1000);
    this.localTimer.unref();
  }
  private async registerSchedule() {
    if (this.stopping) return;
    try {
      await this.queue!.upsertJobScheduler(
        'commerce-poll',
        { every: 2000 },
        { name: 'poll', opts: { removeOnComplete: 10, removeOnFail: 50 } },
      );
    } catch {
      if (!this.stopping) this.retrySchedule = setTimeout(() => void this.registerSchedule(), 5000);
    }
  }
  async onApplicationShutdown() {
    this.stopping = true;
    clearTimeout(this.retrySchedule);
    clearTimeout(this.localTimer);
    await this.localRun;
    await this.worker?.close();
    await this.queue?.close();
  }

  async drain() {
    const tenants = await this.db.client.$queryRaw<
      { id: string }[]
    >`SELECT id FROM tenants WHERE status='active' AND (valid_until IS NULL OR valid_until>now()) ORDER BY id`;
    for (const { id } of tenants) {
      await this.drainTenant(id);
    }
  }

  async drainTenant(id: string) {
    await this.db.client.$transaction(async (tx) => {
      await this.db.context(tx, id);
      await tx.$executeRaw`UPDATE quote_exports SET content=null,status='expired'
          WHERE expires_at<=now() AND status='ready'`;
    });
    // Independent transactions keep completed rows durable even when a later row fails.
    for (let n = 0; n < 50; n++) {
      const worked = await this.db.client.$transaction(
        async (tx) => {
          await this.db.context(tx, id);
          const [task] = await tx.$queryRaw<
            Task[]
          >`SELECT id,tenant_id,topic,resource_id,attempts FROM commerce_outbox
            WHERE tenant_id=${id}::uuid AND finished_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (!task) return false;
          let delay: number | null = null;
          await tx.$executeRawUnsafe('SAVEPOINT commerce_delivery');
          try {
            if (task.topic === 'sync') delay = await processItem(tx, task);
            else if (task.topic === 'inbox') await processInbox(tx, task);
            else await processExport(tx, task);
          } catch {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT commerce_delivery');
            await tx.$executeRaw`UPDATE commerce_outbox SET failures=failures+1,last_error='PROCESSING_ERROR',
              next_attempt_at=now()+interval '1 minute' WHERE id=${task.id}::uuid`;
            this.logger.error('Commerce processing failed for task ' + task.id);
            return true;
          }
          if (delay === null)
            await tx.$executeRaw`UPDATE commerce_outbox SET finished_at=now(),attempts=attempts+1 WHERE id=${task.id}::uuid`;
          else
            await tx.$executeRaw`UPDATE commerce_outbox SET next_attempt_at=now()+make_interval(secs=>${delay}::double precision),attempts=attempts+1 WHERE id=${task.id}::uuid`;
          return true;
        },
        { timeout: 60000 },
      );
      if (!worked) break;
    }
  }
}
