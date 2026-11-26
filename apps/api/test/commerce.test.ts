import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, InputError } from '../src/commerce/pricing';
import { developmentOrder, developmentWarehouse } from '../src/commerce/adapters';
import { batchStatus } from '../src/commerce/orders.controller';

const now = Date.parse('2026-11-24T02:00:00Z');
const rule = {
  objective: 'target_margin_on_price',
  tax_mode: 'tax_on_price',
  commission_rate: '0.10',
  tax_rate: '0.05',
  target_rate: '0.20',
  rate_card: {
    first_weight_kg: '1',
    first_fee: '10',
    step_weight_kg: '0.5',
    step_fee: '2',
    zone_fee: '0',
  },
};
const fx = {
  provider: 'manual',
  base: 'CNY',
  quote: 'AED',
  rate: '0.5',
  fetched_at: new Date(now).toISOString(),
};
const fixture = { sku: 'SKU-DEMO', purchase_cost: '50', weight_kg: '0.7', rule, fx };
const fails = (code: string) => (err: unknown) => err instanceof InputError && err.code === code;

test('T-F2-01 规格样例逐分对账，按舍入后售价拆分佣金、税和利润', () => {
  const { quote: q, warnings } = calculateQuote(fixture, now);
  assert.deepEqual(
    [q.selling_price, q.landed_cost, q.commission, q.tax, q.implied_profit, q.implied_margin],
    ['46.15', '30.00', '4.62', '2.31', '9.22', '0.1998'],
  );
  assert.deepEqual(warnings, []);
});
test('T-F2-02 非正分母、未定税模式、缺汇率、零非免运重量拦截', () => {
  assert.throws(
    () => calculateQuote({ ...fixture, rule: { ...rule, target_rate: '0.85' } }, now),
    fails('DENOMINATOR_INVALID'),
  );
  assert.throws(
    () => calculateQuote({ ...fixture, rule: { ...rule, tax_mode: 'unspecified' } }, now),
    fails('TAX_MODE_REQUIRED'),
  );
  assert.throws(() => calculateQuote({ ...fixture, fx: null }, now), fails('FX_MISSING'));
  assert.throws(() => calculateQuote({ ...fixture, weight_kg: 0 }, now), fails('VALIDATION'));
  assert.equal(
    calculateQuote({ ...fixture, weight_kg: 0, free_shipping: true }, now).quote.landed_cost,
    '25.00',
  );
});
test('T-F2-03 24 小时开始提示，恰好 168 小时仍可算，超时及未来快照拦截', () => {
  const age = (ms: number) => ({ ...fixture, fx: { ...fx, fetched_at: new Date(now - ms).toISOString() } });
  assert.deepEqual(calculateQuote(age(24 * 3600000 - 1), now).warnings, []);
  assert.deepEqual(calculateQuote(age(24 * 3600000), now).warnings, ['FX_STALE_WARNING']);
  assert.deepEqual(calculateQuote(age(168 * 3600000), now).warnings, ['FX_STALE_WARNING']);
  assert.throws(() => calculateQuote(age(168 * 3600000 + 1), now), fails('FX_STALE'));
  assert.throws(() => calculateQuote(age(-1), now), fails('VALIDATION'));
});
test('英制体积先换算，再向上取续重档，运费保持基准币', () => {
  const { weight_kg: _, ...input } = fixture;
  const q = calculateQuote({ ...input, weight_lb: 1, length_in: 10, width_in: 10, height_in: 10 }, now).quote;
  assert.equal(q.billable_weight_kg, '3.277');
  assert.equal(q.freight_in_base, '20.00');
  assert.equal(q.landed_cost, '35.00');
});
test('到岸计税与成本加价，税额独立于售价', () => {
  const q = calculateQuote(
    { ...fixture, rule: { ...rule, tax_mode: 'tax_on_landed', objective: 'markup_on_cost' } },
    now,
  ).quote;
  assert.deepEqual(
    [q.landed_cost, q.selling_price, q.tax, q.commission, q.implied_profit],
    ['30.00', '41.67', '1.50', '4.17', '6.00'],
  );
});
test('T-F1-02 回放货品不带推定数量', () => {
  const demo = developmentOrder('DEMO-1');
  assert.equal(demo.items.length, 3);
  assert(demo.items.every((line) => !('quantity' in line)));
});
test('T-F1-06 超时查单用相同业务键，无查单能力转人工', async () => {
  const key = 'demo-unit',
    payload = { idempotencyKey: key, sku: 'SKU', quantity: '1' };
  const slow = developmentWarehouse('timeout', 1),
    offline = developmentWarehouse('no_query', 1);
  assert.deepEqual(await slow.submit(payload), { type: 'timeout' });
  assert.deepEqual(await slow.query(key), { state: 'accepted', ref: 'DEMO-WH-' + key });
  assert.equal(offline.hasQuery, false);
  assert.deepEqual(await offline.query(key), { state: 'unknown' });
});
test('T-F1 批次显示待处理、部分成功与人工待办', () => {
  assert.equal(batchStatus([{ status: 'queued' }, { status: 'queued' }]).status, 'queued');
  assert.equal(batchStatus([{ status: 'submitted' }, { status: 'queued' }]).status, 'running');
  assert.deepEqual(batchStatus([{ status: 'needs_manual' }, { status: 'submitted' }, { status: 'failed' }]), {
    status: 'partial',
    total: 3,
    succeeded: 1,
    failed: 1,
    indeterminate: 1,
  });
});
