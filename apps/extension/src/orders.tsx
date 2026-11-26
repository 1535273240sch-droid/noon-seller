import { useEffect, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { api, type Actor } from "./api";
import {
  Empty,
  Feedback,
  Field,
  Panel,
  statusText,
  useTask,
} from "./components";

type Line = {
  id: string;
  partner_sku: string;
  quantity: string | null;
  quantity_source: string;
  version: number;
  sync_status: string | null;
  batch_id: string | null;
};
type Order = {
  id: string;
  fbpi_order_nr: string;
  source: string;
  lines: Line[];
};
export function Orders({ actor }: { actor: Actor }) {
  const [orders, setOrders] = useState<Order[]>([]),
    [sku, setSku] = useState(""),
    [state, setState] = useState(""),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Order | null>(null),
    [batch, setBatch] = useState<any>(null),
    [note, setNote] = useState("");
  const task = useTask(),
    can = actor.permissions.includes("orders.sync");
  const list = async (next = "") => {
    const params = new URLSearchParams({ sku, status: state });
    if (next) params.set("cursor", next);
    const v = await api("/orders?" + params);
    setOrders((old) => (next ? [...old, ...v.data] : v.data));
    setCursor(v.next_cursor || "");
    if (!next) setSelected([]);
  };
  const open = async (id: string) =>
    setDetail((await api("/orders/" + id)).order);
  const getBatch = async (id: string) =>
    setBatch(await api("/sync-batches/" + id));
  useEffect(() => {
    void task.run(() => list());
  }, []);
  return (
    <>
      <Feedback task={task} />
      {note && <p className="notice">{note}</p>}
      <Panel
        title="订单列表"
        extra={
          <button
            onClick={() => void task.run(() => list())}
            disabled={task.busy}
          >
            <RefreshCw size={15} />
            刷新
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
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="商品 SKU"
            aria-label="商品 SKU"
          />
          <select
            aria-label="同步状态"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">全部状态</option>
            {[
              "blocked_quantity",
              "ready",
              "queued",
              "submitted",
              "failed",
              "indeterminate",
              "needs_manual",
            ].map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </select>
          <button>筛选</button>
        </form>
        {orders.length ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>订单号</th>
                  <th>商品 SKU</th>
                  <th>数量</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orders.flatMap((o) =>
                  o.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={"选择 " + l.partner_sku}
                          disabled={
                            !can ||
                            !l.quantity ||
                            !!l.sync_status ||
                            (!selected.includes(l.id) && selected.length >= 50)
                          }
                          checked={selected.includes(l.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, l.id]
                                : selected.filter((id) => id !== l.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        {o.fbpi_order_nr}
                        {o.source === "dev_mock" && (
                          <small className="muted"> · 模拟</small>
                        )}
                      </td>
                      <td>{l.partner_sku}</td>
                      <td>{l.quantity ?? "待确认"}</td>
                      <td>
                        {statusText(
                          l.sync_status ||
                            (l.quantity ? "ready" : "blocked_quantity"),
                        )}
                      </td>
                      <td>
                        <button onClick={() => void task.run(() => open(o.id))}>
                          详情
                        </button>{" "}
                        {l.batch_id && (
                          <button
                            onClick={() =>
                              void task.run(() => getBatch(l.batch_id!))
                            }
                          >
                            批次
                          </button>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无订单。已连接的订单将在这里显示。</Empty>
        )}
        <div className="actions">
          <button
            className="primary"
            disabled={!can || !selected.length || task.busy}
            onClick={() =>
              void task.run(async () => {
                const v = await api("/sync-batches", "POST", {
                  order_line_ids: selected,
                });
                await getBatch(v.batch.id);
                await list();
              })
            }
          >
            <Send size={15} />
            同步已选行（{selected.length}）
          </button>
          {cursor && (
            <button onClick={() => void task.run(() => list(cursor))}>
              下一页
            </button>
          )}
          {can && import.meta.env.WXT_DEMO_UI === "true" && (
            <button
              onClick={() =>
                void task.run(async () => {
                  const v = await api("/dev/orders", "POST", {});
                  setNote("模拟订单已接收：" + v.order_nr + "。稍后刷新列表。");
                })
              }
            >
              导入模拟订单
            </button>
          )}
        </div>
      </Panel>
      {detail && (
        <Panel
          title={"订单 " + detail.fbpi_order_nr}
          extra={<button onClick={() => setDetail(null)}>关闭详情</button>}
        >
          {detail.lines.map((l) => (
            <form
              className="list-item toolbar"
              key={l.id + ":" + l.version}
              onSubmit={(e) => {
                e.preventDefault();
                const quantity = String(
                  new FormData(e.currentTarget).get("quantity"),
                );
                void task.run(async () => {
                  await api(
                    "/orders/" + detail.id + "/lines/" + l.id,
                    "PATCH",
                    { quantity, version: l.version },
                  );
                  await open(detail.id);
                  await list();
                });
              }}
            >
              <strong>{l.partner_sku}</strong>
              <Field label="确认数量">
                <input
                  name="quantity"
                  type="number"
                  min=".001"
                  step=".001"
                  defaultValue={l.quantity || ""}
                  required
                  disabled={!can || !!l.sync_status}
                />
              </Field>
              <button disabled={!can || !!l.sync_status || task.busy}>
                保存数量
              </button>
            </form>
          ))}
        </Panel>
      )}
      {batch && (
        <Panel
          title="同步批次"
          extra={
            <button
              onClick={() => void task.run(() => getBatch(batch.batch.id))}
            >
              刷新批次
            </button>
          }
        >
          <p>
            {statusText(batch.batch.status)} · 共 {batch.batch.total} 行 ·
            已受理 {batch.batch.succeeded} 行
          </p>
          {batch.items.map((item: any) => (
            <div className="list-item" key={item.id}>
              <div className="row">
                <span className="badge">{statusText(item.status)}</span>
                <span>
                  {item.warehouse_ref || item.last_error || item.line_id}
                </span>
              </div>
              {can && item.status === "failed" && item.retryable && (
                <button
                  onClick={() =>
                    void task.run(async () => {
                      await api(
                        "/sync-items/" + item.id + "/retry",
                        "POST",
                        {},
                      );
                      await getBatch(batch.batch.id);
                    })
                  }
                >
                  重试
                </button>
              )}
              {can && item.status === "indeterminate" && (
                <button
                  onClick={() =>
                    void task.run(async () => {
                      await api(
                        "/sync-items/" + item.id + "/manual",
                        "POST",
                        {},
                      );
                      await getBatch(batch.batch.id);
                    })
                  }
                >
                  转人工处置
                </button>
              )}
              {can &&
                ["submitted", "tracking_updated"].includes(item.status) && (
                  <form
                    className="toolbar"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      void task.run(async () => {
                        await api(
                          "/sync-items/" + item.id + "/tracking",
                          "PATCH",
                          {
                            ...Object.fromEntries(form),
                            version: item.version,
                          },
                        );
                        await getBatch(batch.batch.id);
                      });
                    }}
                  >
                    <input
                      required
                      name="carrier"
                      aria-label="物流商"
                      placeholder="物流商"
                      defaultValue={item.tracking?.carrier}
                    />
                    <input
                      required
                      name="tracking_number"
                      aria-label="运单号"
                      placeholder="运单号"
                      defaultValue={item.tracking?.tracking_number}
                    />
                    <button>保存运单</button>
                  </form>
                )}
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
