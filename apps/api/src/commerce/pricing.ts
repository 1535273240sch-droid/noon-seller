import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const supportedCurrencies = ["CNY", "AED", "SAR", "USD"];
const fixed12 = (n: Decimal) => n.toDecimalPlaces(12);

export class InputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function invalid(message: string, code = "VALIDATION"): never {
  throw new InputError(code, message);
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("需要 JSON 对象");
  return value as Record<string, unknown>;
}

export function textField(value: unknown, name: string, max = 128) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    invalid(name + " 无效");
  return value.trim();
}

function numberField(value: unknown, name: string, positive = false) {
  const source =
    typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(source))
    invalid(name + " 须为非负十进制数");
  const result = new D(source);
  if (positive && result.isZero()) invalid(name + " 须大于零");
  return result;
}

function rate(value: unknown, name: string) {
  const result = numberField(value, name);
  if (result.gt("0.99") || result.decimalPlaces() > 6)
    invalid(name + " 超出范围或精度");
  return result.toString();
}

export function pricingRule(raw: unknown) {
  const r = record(raw);
  if (r.tax_mode !== "tax_on_landed" && r.tax_mode !== "tax_on_price")
    invalid("请选择计税基础", "TAX_MODE_REQUIRED");
  if (
    r.objective !== "markup_on_cost" &&
    r.objective !== "target_margin_on_price"
  )
    invalid("请选择定价目标");
  const c = record(r.rate_card);
  if (
    r.freight_in_landed !== undefined &&
    typeof r.freight_in_landed !== "boolean"
  )
    invalid("freight_in_landed 应为布尔值");
  return {
    objective: r.objective,
    tax_mode: r.tax_mode,
    commission_rate: rate(r.commission_rate, "commission_rate"),
    tax_rate: rate(r.tax_rate, "tax_rate"),
    target_rate: rate(r.target_rate, "target_rate"),
    freight_in_landed: r.freight_in_landed ?? true,
    volumetric_divisor: numberField(
      r.volumetric_divisor ?? 5000,
      "volumetric_divisor",
      true,
    ).toString(),
    rate_card: {
      first_weight_kg: numberField(
        c.first_weight_kg,
        "first_weight_kg",
        true,
      ).toString(),
      first_fee: numberField(c.first_fee, "first_fee").toString(),
      step_weight_kg: numberField(
        c.step_weight_kg,
        "step_weight_kg",
        true,
      ).toString(),
      step_fee: numberField(c.step_fee, "step_fee").toString(),
      zone_fee: numberField(c.zone_fee ?? 0, "zone_fee").toString(),
    },
  };
}

export function manualFx(raw: unknown, now: number) {
  if (!raw) invalid("请提供手工汇率快照", "FX_MISSING");
  const fx = record(raw);
  const base = textField(fx.base, "base", 3),
    quote = textField(fx.quote, "quote", 3);
  if (
    !supportedCurrencies.includes(base) ||
    !supportedCurrencies.includes(quote) ||
    fx.provider !== "manual"
  )
    invalid("汇率币对或来源无效");
  const r = numberField(fx.rate, "rate", true);
  if (base === quote && !r.eq(1)) invalid("同币种汇率须为 1");
  const timestamp = textField(fx.fetched_at, "fetched_at", 40);
  const t = Date.parse(timestamp);
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ||
    !Number.isFinite(t) ||
    t > now
  )
    invalid("取数时间必须带时区且不能晚于当前时间");
  const hours = (now - t) / 3_600_000;
  if (hours > 168) invalid("汇率超过 168 小时，请更新快照", "FX_STALE");
  return {
    fx: {
      provider: "manual",
      base,
      quote,
      rate: r.toString(),
      fetched_at: new Date(t).toISOString(),
    },
    warnings: hours >= 24 ? ["FX_STALE_WARNING"] : [],
  };
}

export function calculateQuote(raw: unknown, now = Date.now()) {
  const input = record(raw),
    rule = pricingRule(input.rule),
    { fx, warnings } = manualFx(input.fx, now);
  const sku = textField(input.sku, "sku");
  const cost = numberField(input.purchase_cost, "purchase_cost");
  if (
    input.free_shipping !== undefined &&
    typeof input.free_shipping !== "boolean"
  )
    invalid("free_shipping 应为布尔值");
  if (input.weight_kg !== undefined && input.weight_lb !== undefined)
    invalid("重量只能选用一种单位");
  const weight =
    input.weight_lb === undefined
      ? numberField(input.weight_kg, "weight_kg")
      : numberField(input.weight_lb, "weight_lb").times("0.45359237");
  if (weight.isZero() && !input.free_shipping) invalid("实重为零，请确认免运");
  const measures = ["length", "width", "height"];
  const dimUnit = measures.some((k) => input[k + "_in"] !== undefined)
    ? "_in"
    : "_cm";
  if (dimUnit === "_in" && measures.some((k) => input[k + "_cm"] !== undefined))
    invalid("尺寸单位冲突");
  const dimensions = measures.map((k) => input[k + dimUnit]);
  const hasDimensions = dimensions.some((v) => v !== undefined);
  const volume = hasDimensions
    ? dimensions.reduce<Decimal>(
        (v, size) =>
          v
            .times(numberField(size, "dimension", true))
            .times(dimUnit === "_in" ? "2.54" : 1),
        new D(1),
      )
    : new D(0);
  const billable = fixed12(D.max(weight, volume.div(rule.volumetric_divisor)));
  const card = rule.rate_card;
  const steps = D.max(0, billable.minus(card.first_weight_kg))
    .div(card.step_weight_kg)
    .ceil();
  const freight = input.free_shipping
    ? new D(0)
    : new D(card.first_fee)
        .plus(steps.times(card.step_fee))
        .plus(card.zone_fee);
  const landed = fixed12(
    cost.plus(rule.freight_in_landed ? freight : 0).times(fx.rate),
  );
  const priceTax = rule.tax_mode === "tax_on_price";
  const margin = rule.objective === "target_margin_on_price";
  const denom = new D(1)
    .minus(rule.commission_rate)
    .minus(priceTax ? rule.tax_rate : 0)
    .minus(margin ? rule.target_rate : 0);
  if (denom.lte(0)) invalid("定价分母须大于零", "DENOMINATOR_INVALID");
  const landedTax = priceTax ? new D(0) : landed.times(rule.tax_rate);
  const numerator = landed
    .plus(landedTax)
    .plus(margin ? 0 : landed.times(rule.target_rate));
  const exact = fixed12(numerator.div(denom)),
    selling = exact.toDecimalPlaces(2);
  const commission = selling.times(rule.commission_rate).toDecimalPlaces(2);
  const tax = (
    priceTax ? selling.times(rule.tax_rate) : landedTax
  ).toDecimalPlaces(2);
  const profit = selling
    .minus(landed.toDecimalPlaces(2))
    .minus(commission)
    .minus(tax);
  return {
    blocking_error: null,
    warnings,
    quote: {
      sku,
      currency: fx.quote,
      selling_price: selling.toFixed(2),
      landed_cost: landed.toFixed(2),
      commission: commission.toFixed(2),
      tax: tax.toFixed(2),
      implied_profit: profit.toFixed(2),
      implied_margin: selling.isZero() ? null : profit.div(selling).toFixed(4),
      billable_weight_kg: billable.toFixed(3),
      freight_in_base: freight.toFixed(2),
      unrounded_price: exact.toFixed(12),
      unrounded_landed: landed.toFixed(12),
      fx,
    },
  };
}
