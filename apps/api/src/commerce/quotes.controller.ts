import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { Actor, CurrentActor, Db, Permit, Tx, apiError } from '../core';
import { calculateQuote, manualFx, pricingRule, record, textField } from './pricing';
import { addTask, conflict, json, missing, page, pageSize, uuid, validate, version } from './shared';

type RuleRow = { id: string; name: string; version: number; rule: ReturnType<typeof pricingRule> };
const skuValue = (s?: string) => (s === undefined || s === '' ? null : validate(() => textField(s, 'sku')));

async function saveFx(tx: Tx, tid: string, fx: ReturnType<typeof manualFx>['fx']) {
  const [row] = await tx.$queryRaw<
    { id: string }[]
  >`INSERT INTO fx_snapshots(tenant_id,provider,base,quote,rate,fetched_at)
    VALUES(${tid}::uuid,'manual',${fx.base},${fx.quote},${fx.rate}::numeric,${new Date(fx.fetched_at)}) RETURNING id`;
  return row.id;
}

@Controller()
export class QuotesController {
  constructor(private readonly db: Db) {}

  @Get('pricing-rules')
  @Permit('quotes.read')
  listRules(@CurrentActor() actor: Actor) {
    return this.db.tenant(actor, async (tx) => ({
      data: await tx.$queryRaw<RuleRow[]>`SELECT id,name,version,rule FROM pricing_rules ORDER BY name`,
    }));
  }

  @Put('pricing-rules/:id')
  @Permit('quotes.write')
  rule(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() raw: unknown) {
    id = uuid(id);
    const b = validate(() => record(raw)),
      inputVersion = version(b.version);
    const rule = validate(() => pricingRule(b)),
      name = validate(() => textField(b.name, 'name'));
    return this.db.tenant(actor, async (tx) => {
      let rows: RuleRow[];
      if (inputVersion === 0) {
        rows =
          await tx.$queryRaw`INSERT INTO pricing_rules(id,tenant_id,name,rule) VALUES(${id}::uuid,${actor.tid}::uuid,${name},${json(rule)})
          ON CONFLICT DO NOTHING RETURNING id,name,version,rule`;
      } else {
        rows = await tx.$queryRaw`UPDATE pricing_rules SET name=${name},rule=${json(rule)},version=version+1
          WHERE id=${id}::uuid AND version=${inputVersion} RETURNING id,name,version,rule`;
      }
      return { rule: rows[0] ?? conflict() };
    });
  }

  @Post('quotes/preview')
  @HttpCode(200)
  @Permit('quotes.write')
  preview(@Body() raw: unknown) {
    return validate(() => calculateQuote(raw));
  }

  @Post('fx/refresh')
  @Permit('quotes.write')
  fx(@CurrentActor() actor: Actor, @Headers('idempotency-key') key: string, @Body() raw: unknown) {
    return this.db.write(actor, key, 'fx.refresh', raw, async (tx) => {
      const { fx, warnings } = validate(() => manualFx(raw, Date.now()));
      return { id: await saveFx(tx, actor.tid!, fx), fx, warnings };
    });
  }

  @Post('quotes')
  @Permit('quotes.write')
  save(@CurrentActor() actor: Actor, @Headers('idempotency-key') key: string, @Body() raw: unknown) {
    const b = validate(() => record(raw)),
      id = uuid(b.rule_id),
      expected = version(b.rule_version);
    return this.db.write(actor, key, 'quotes.save', b, async (tx) => {
      const [rule] = await tx.$queryRaw<
        RuleRow[]
      >`SELECT id,name,version,rule FROM pricing_rules WHERE id=${id}::uuid FOR SHARE`;
      if (!rule) missing();
      if (rule.version !== expected) conflict();
      const inputs = { ...b, rule: rule.rule };
      const result = validate(() => calculateQuote(inputs)),
        quote = result.quote,
        fxId = await saveFx(tx, actor.tid!, quote.fx);
      const [row] = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO quotes(tenant_id,rule_id,rule_version,fx_snapshot_id,sku,inputs,breakdown,created_by)
        VALUES(${actor.tid}::uuid,${id}::uuid,${expected},${fxId}::uuid,${quote.sku},${json(inputs)},${json(quote)},${actor.uid}::uuid) RETURNING id`;
      return { ...result, id: row.id, fx_snapshot_id: fxId, rule_id: id, rule_version: expected };
    });
  }

  @Get('quotes')
  @Permit('quotes.read')
  history(
    @CurrentActor() actor: Actor,
    @Query('sku') sku?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const size = pageSize(limit),
      filter = skuValue(sku);
    const whereSku = filter ? Prisma.sql`AND sku=${filter}` : Prisma.empty;
    const seek = cursor
      ? Prisma.sql`AND (created_at,id)<(SELECT created_at,id FROM quotes WHERE id=${uuid(cursor)}::uuid)`
      : Prisma.empty;
    return this.db.tenant(actor, async (tx) =>
      page(
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT id,sku,rule_id,rule_version,fx_snapshot_id,breakdown AS quote,created_at
      FROM quotes WHERE true ${whereSku} ${seek} ORDER BY created_at DESC,id DESC LIMIT ${size + 1}`,
        size,
      ),
    );
  }

  @Post('quotes/export')
  @HttpCode(202)
  @Permit('quotes.read')
  export(@CurrentActor() actor: Actor, @Headers('idempotency-key') key: string, @Body() raw: unknown) {
    const sku = skuValue(validate(() => record(raw ?? {})).sku as string | undefined);
    return this.db.write(actor, key, 'quotes.export', { sku }, async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO quote_exports(tenant_id,created_by,filter_sku)
        VALUES(${actor.tid}::uuid,${actor.uid}::uuid,${sku}) RETURNING id`;
      await addTask(tx, actor.tid!, 'export', row.id);
      return { job_id: row.id, status: 'queued' };
    });
  }

  @Get('quotes/exports/:id')
  @Permit('quotes.read')
  exportStatus(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.db.tenant(actor, async (tx) => {
      const [job] = await tx.$queryRaw<
        { id: string; status: string; expires_at: Date | null }[]
      >`SELECT id,status,expires_at FROM quote_exports WHERE id=${uuid(id)}::uuid AND created_by=${actor.uid}::uuid`;
      if (!job) missing();
      const expired = job.expires_at && job.expires_at.getTime() <= Date.now();
      return {
        ...job,
        status: expired ? 'expired' : job.status,
        download_url: !expired && job.status === 'ready' ? '/v1/quotes/exports/' + job.id + '/download' : null,
      };
    });
  }

  @Get('quotes/exports/:id/download')
  @Permit('quotes.read')
  async download(@CurrentActor() actor: Actor, @Param('id') id: string, @Res() res: FastifyReply) {
    const data = await this.db.tenant(actor, async (tx) => {
      const [r] = await tx.$queryRaw<
        { content: Uint8Array | null; expires_at: Date | null }[]
      >`SELECT content,expires_at FROM quote_exports WHERE id=${uuid(id)}::uuid AND created_by=${actor.uid}::uuid`;
      if (!r) missing();
      if (r.expires_at && r.expires_at.getTime() <= Date.now()) throw apiError(410, 'EXPIRED', '导出已过期');
      if (!r.content) throw apiError(409, 'EXPORT_NOT_READY', '导出尚未就绪');
      return Buffer.from(r.content);
    });
    return res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="noon-quotes.xlsx"')
      .header('Cache-Control', 'no-store')
      .send(data);
  }
}
