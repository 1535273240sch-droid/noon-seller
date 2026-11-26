import { useEffect, useState } from "react";
import { ArrowDownToLine, Calculator, Save } from "lucide-react";
import { api, apiOrigin, type Actor } from "./api";
import {
  Empty,
  Feedback,
  Field,
  FormButton,
  Panel,
  useTask,
} from "./components";
import { downloadFile } from "./download";

const defaults = {
  sku: "",
  purchase: "50",
  base: "CNY",
  currency: "AED",
  rate: "0.50",
  fxDate: "",
  weight: "1",
  length: "",
  width: "",
  height: "",
  firstWeight: "1",
  firstFee: "10",
  stepWeight: "1",
  stepFee: "0",
  zoneFee: "0",
  divisor: "5000",
  objective: "target_margin_on_price",
  taxMode: "tax_on_price",
  commission: "10",
  tax: "5",
  target: "20",
};
type Key = keyof typeof defaults;
function nowLocal() {
  const d = new Date();
  return new Date(d.getTime() - 60000 * d.getTimezoneOffset())
    .toISOString()
    .slice(0, 16);
}
function pct(s: string) {
  if (!/^\d+(\.\d{1,4})?$/.test(s))
    throw new Error("费率最多支持四位百分比小数。");
  const [whole, frac = ""] = s.split(".");
  const v = (whole + frac.padEnd(4, "0")).padStart(7, "0");
  return v.slice(0, -6) + "." + v.slice(-6);
}
export function Quotes({ actor }: { actor: Actor }) {
  const [f, setF] = useState({ ...defaults, fxDate: nowLocal() }),
    [free, setFree] = useState(false),
    [include, setInclude] = useState(true);
  const [preview, setPreview] = useState<any>(null),
    [saved, setSaved] = useState(""),
    [history, setHistory] = useState<any[]>([]),
    [filter, setFilter] = useState(""),
    [exportId, setExport] = useState(""),
    [ruleName, setName] = useState("标准报价"),
    [activeRule, setRule] = useState<{ id: string; version: number } | null>(
      null,
    );
  const [rules, setRules] = useState<any[]>([]),
    [fxNote, setFxNote] = useState("");
  function selectRule(row: any) {
    if (!row) {
      setRule(null);
      setName("");
      setPreview(null);
      return;
    }
    const r = row.rule,
      c = r.rate_card;
    const percent = (x: string) =>
      (Number(x) * 100).toFixed(4).replace(/\.?0+$/, "") || "0";
    setF((current) => ({
      ...current,
      objective: r.objective,
      taxMode: r.tax_mode,
      divisor: r.volumetric_divisor,
      commission: percent(r.commission_rate),
      tax: percent(r.tax_rate),
      target: percent(r.target_rate),
      firstWeight: c.first_weight_kg,
      firstFee: c.first_fee,
      stepWeight: c.step_weight_kg,
      stepFee: c.step_fee,
      zoneFee: c.zone_fee,
    }));
    setInclude(r.freight_in_landed);
    setName(row.name);
    setRule({ id: row.id, version: row.version });
    setPreview(null);
    setSaved("");
  }
  const task = useTask(),
    write = actor.permissions.includes("quotes.write");
  const change = (key: Key, value: string) => {
    setF({ ...f, [key]: value });
    setPreview(null);
    setSaved("");
  };
  const input = (key: Key, label: string, type = "text", required = true) => (
    <Field label={label}>
      <input
        type={type}
        step={type === "number" ? "any" : undefined}
        min={type === "number" ? 0 : undefined}
        value={f[key]}
        required={required}
        onChange={(e) => change(key, e.target.value)}
      />
    </Field>
  );
  const rule = () => ({
    objective: f.objective,
    tax_mode: f.taxMode,
    commission_rate: pct(f.commission),
    tax_rate: pct(f.tax),
    target_rate: pct(f.target),
    freight_in_landed: include,
    volumetric_divisor: f.divisor,
    rate_card: {
      first_weight_kg: f.firstWeight,
      first_fee: f.firstFee,
      step_weight_kg: f.stepWeight,
      step_fee: f.stepFee,
      zone_fee: f.zoneFee,
    },
  });
  const body = () => ({
    sku: f.sku,
    purchase_cost: f.purchase,
    weight_kg: f.weight,
    ...(f.length || f.width || f.height
      ? { length_cm: f.length, width_cm: f.width, height_cm: f.height }
      : {}),
    free_shipping: free,
    rule: rule(),
    fx: {
      provider: "manual",
      base: f.base,
      quote: f.currency,
      rate: f.rate,
      fetched_at: new Date(f.fxDate).toISOString(),
    },
  });
  const list = async (q = filter) =>
    setHistory((await api("/quotes?sku=" + encodeURIComponent(q))).data);
  useEffect(() => {
    void task.run(async () => {
      const r = await api("/pricing-rules");
      setRules(r.data);
      if (r.data.length) selectRule(r.data[0]);
      await list("");
    });
  }, []);
  return (
    <>
      <Feedback task={task} />
      <div className="columns">
        <Panel title="报价参数">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                setPreview(await api("/quotes/preview", "POST", body()));
                setSaved("");
              });
            }}
          >
            {rules.length > 0 && (
              <div className="toolbar">
                <Field label="已保存的计价规则">
                  <select
                    value={activeRule?.id || ""}
                    onChange={(e) =>
                      selectRule(rules.find((r) => r.id === e.target.value))
                    }
                  >
                    <option value="">新建规则</option>
                    {rules.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <div className="grid">
              {input("sku", "商品 SKU")}
              {input("purchase", "采购成本", "number")}
              {input("base", "成本币种")}
              {input("currency", "报价币种")}
              {input("rate", "手工汇率（1 单位成本币）", "number")}
              {input("fxDate", "汇率取数时间", "datetime-local")}
              {input("weight", "实重（kg）", "number")}
              {input("firstFee", "首重运费（成本币）", "number")}
            </div>
            <details>
              <summary>运费与体积重</summary>
              <div className="grid">
                {input("length", "长（cm）", "number", false)}
                {input("width", "宽（cm）", "number", false)}
                {input("height", "高（cm）", "number", false)}
                {input("divisor", "抛重系数", "number")}
                {input("firstWeight", "首重（kg）", "number")}
                {input("stepWeight", "续重单位（kg）", "number")}
                {input("stepFee", "每单位续重费用", "number")}
                {input("zoneFee", "分区附加费", "number")}
              </div>
              <div className="toolbar">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={free}
                    onChange={(e) => {
                      setFree(e.target.checked);
                      setPreview(null);
                    }}
                  />
                  免运
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={include}
                    onChange={(e) => {
                      setInclude(e.target.checked);
                      setPreview(null);
                    }}
                  />
                  运费计入到岸成本
                </label>
              </div>
            </details>
            <div className="grid">
              <Field label="定价目标">
                <select
                  value={f.objective}
                  onChange={(e) => change("objective", e.target.value)}
                >
                  <option value="target_margin_on_price">售价毛利率</option>
                  <option value="markup_on_cost">成本加价率</option>
                </select>
              </Field>
              <Field label="税基">
                <select
                  value={f.taxMode}
                  onChange={(e) => change("taxMode", e.target.value)}
                >
                  <option value="tax_on_price">按售价计税</option>
                  <option value="tax_on_landed">按到岸成本计税</option>
                </select>
              </Field>
              {input("commission", "佣金率（%）", "number")}
              {input("tax", "税率（%）", "number")}
              {input("target", "目标比率（%）", "number")}
              <Field label="计价规则名称">
                <input
                  value={ruleName}
                  required
                  onChange={(e) => {
                    setName(e.target.value);
                    setRule(null);
                    setPreview(null);
                  }}
                />
              </Field>
            </div>
            <div className="actions">
              <FormButton disabled={!write || task.busy}>
                <Calculator size={16} />
                计算预览
              </FormButton>
              <button
                type="button"
                disabled={!write || task.busy}
                onClick={() =>
                  void task.run(async () => {
                    await api("/fx/refresh", "POST", body().fx);
                    setFxNote("手工汇率快照已记录。");
                  })
                }
              >
                记录手工汇率
              </button>
            </div>
            {fxNote && <p className="notice">{fxNote}</p>}
          </form>
        </Panel>
        <Panel title="报价明细">
          {preview ? (
            <>
              <div className="price">
                {preview.quote.selling_price}
                <small>{preview.quote.currency}</small>
              </div>
              <dl className="kv">
                {[
                  ["到岸成本", "landed_cost"],
                  ["佣金", "commission"],
                  ["税费", "tax"],
                  ["利润", "implied_profit"],
                  ["实际毛利率", "implied_margin"],
                ].map(([label, key]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {key === "implied_margin"
                        ? (Number(preview.quote[key]) * 100).toFixed(2) + "%"
                        : preview.quote[key]}
                    </dd>
                  </div>
                ))}
              </dl>
              {preview.warnings?.length > 0 && (
                <p className="notice">{preview.warnings.join(" · ")}</p>
              )}
              <button
                disabled={task.busy || !write || !!saved}
                onClick={() =>
                  void task.run(async () => {
                    const id = activeRule?.id ?? crypto.randomUUID();
                    const updated = await api("/pricing-rules/" + id, "PUT", {
                      ...rule(),
                      name: ruleName,
                      version: activeRule?.version ?? 0,
                    });
                    const version =
                      updated.rule?.version ??
                      updated.version ??
                      (activeRule?.version ?? 0) + 1;
                    setRule({ id, version });
                    await api("/quotes", "POST", {
                      ...body(),
                      rule_id: id,
                      rule_version: version,
                    });
                    setSaved("报价已保存");
                    setRules((await api("/pricing-rules")).data);
                    await list();
                  })
                }
              >
                <Save size={15} />
                保存报价
              </button>
              {saved && <p className="notice">{saved}</p>}
            </>
          ) : (
            <Empty>计算后可查看售价、费用和实际毛利率。</Empty>
          )}
        </Panel>
      </div>
      <Panel
        title="报价历史"
        extra={
          <button
            disabled={task.busy}
            onClick={() =>
              void task.run(async () => {
                const v = await api(
                  "/quotes/export",
                  "POST",
                  filter ? { sku: filter } : {},
                );
                setExport(v.job_id);
              })
            }
          >
            <ArrowDownToLine size={15} />
            导出 Excel
          </button>
        }
      >
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(() => list());
          }}
        >
          <input
            aria-label="按 SKU 筛选"
            placeholder="按 SKU 筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button>查询</button>
        </form>
        {exportId && (
          <button
            onClick={() =>
              void task.run(async () => {
                const result = await api("/quotes/exports/" + exportId);
                if (!result.download_url)
                  throw new Error(
                    "导出状态 " + result.status + "，请稍后再试。",
                  );
                await downloadFile(
                  new URL(result.download_url, apiOrigin).pathname,
                  "quotes.xlsx",
                );
                setExport("");
              })
            }
          >
            查看导出结果
          </button>
        )}
        {history.length ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>售价</th>
                  <th>实际毛利率</th>
                  <th>保存时间</th>
                </tr>
              </thead>
              <tbody>
                {history.map((q) => {
                  const v = q.breakdown?.quote ?? q.breakdown ?? q.quote ?? q;
                  return (
                    <tr key={q.id}>
                      <td>{q.sku}</td>
                      <td>
                        {v.selling_price} {v.currency}
                      </td>
                      <td>
                        {v.implied_margin == null
                          ? "—"
                          : (Number(v.implied_margin) * 100).toFixed(2) + "%"}
                      </td>
                      <td>{new Date(q.created_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无符合条件的报价。</Empty>
        )}
      </Panel>
    </>
  );
}
