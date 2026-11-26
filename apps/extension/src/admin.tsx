import { useEffect, useState } from "react";
import { api, apiOrigin, type Actor } from "./api";
import {
  Feedback,
  Field,
  Empty,
  Panel,
  statusText,
  useTask,
} from "./components";

const modules: Record<string, string> = {
  orders: "订单",
  quotes: "报价",
  assets: "素材",
  reco: "爆款",
  settings: "设置",
};
function Grants({ initial = Object.keys(modules) }: { initial?: string[] }) {
  return (
    <div className="toolbar">
      {Object.entries(modules).map(([id, name]) => (
        <label className="check" key={id}>
          <input
            type="checkbox"
            name="modules"
            value={id}
            defaultChecked={initial.includes(id)}
          />
          {name}
        </label>
      ))}
    </div>
  );
}
function UserCreate({
  team,
  onCreated,
}: {
  team?: boolean;
  onCreated?: () => Promise<void>;
}) {
  const task = useTask(),
    [oneTime, setPassword] = useState("");
  return (
    <Panel title={team ? "邀请操作员" : "创建账号"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          void task.run(async () => {
            setPassword("");
            const tid = String(f.get("tenant_id") || "");
            const v = await api(team ? "/team/users" : "/admin/users", "POST", {
              email: f.get("email"),
              role: team ? "tenant_member" : f.get("role"),
              modules: f.getAll("modules"),
              max_sessions: Number(f.get("max_sessions") || 2),
              ...(tid ? { tenant_id: tid } : {}),
            });
            setPassword(v.temporary_password);
            form.reset();
            if (onCreated) await onCreated();
          });
        }}
      >
        <div className="grid">
          <Field label="登录邮箱">
            <input name="email" type="email" required />
          </Field>
          <Field label="并发会话上限">
            <input
              type="number"
              min="1"
              name="max_sessions"
              defaultValue="2"
              required
            />
          </Field>
          {!team && (
            <>
              <Field label="角色">
                <select name="role">
                  <option value="tenant_admin">租户管理员</option>
                  <option value="tenant_member">租户操作员</option>
                </select>
              </Field>
              <Field label="现有租户 ID（留空新建）">
                <input name="tenant_id" />
              </Field>
            </>
          )}
        </div>
        <Grants />
        <button disabled={task.busy} className="primary">
          创建账号
        </button>
      </form>
      {oneTime && (
        <div className="notice">
          请将此临时密码安全交给用户。
          <br />
          <code>{oneTime}</code>{" "}
          <button onClick={() => setPassword("")}>已保存，隐藏密码</button>
        </div>
      )}
      <Feedback task={task} />
    </Panel>
  );
}
export function Accounts() {
  const task = useTask(),
    [users, setUsers] = useState<any[]>([]),
    [stats, setStats] = useState<any>(null),
    [selected, setSelected] = useState<any>(null),
    [cursor, setCursor] = useState("");
  const load = async (next = "") => {
    const [u, s] = await Promise.all([
      api(
        "/admin/users?limit=50" +
          (next ? "&cursor=" + encodeURIComponent(next) : ""),
      ),
      api("/admin/stats"),
    ]);
    setUsers((old) => (next ? [...old, ...u.data] : u.data));
    setCursor(u.next_cursor || "");
    setStats(s);
  };
  useEffect(() => {
    void task.run(() => load());
  }, []);
  return (
    <>
      <Feedback task={task} />
      <Panel title="全局汇总">
        {stats && (
          <dl className="kv">
            {[
              ["租户", "tenants"],
              ["用户", "users"],
              ["有效会话", "active_sessions"],
            ].map(([name, key]) => (
              <div key={key}>
                <dt>{name}</dt>
                <dd>{stats[key]}</dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>
      <UserCreate onCreated={load} />
      <Panel
        title="终端账号"
        extra={
          <button onClick={() => void task.run(() => load())}>刷新</button>
        }
      >
        {users
          .filter((u) => u.role !== "platform_admin")
          .map((u) => (
            <div key={u.id} className="list-item toolbar">
              <strong>{u.email}</strong>
              <span>{statusText(u.status)}</span>
              <button
                disabled={u.status === "deleted"}
                onClick={() => setSelected(u)}
              >
                管理
              </button>
            </div>
          ))}
        {!users.some((u) => u.role !== "platform_admin") && (
          <Empty>暂无终端账号。</Empty>
        )}
        {cursor && (
          <button onClick={() => void task.run(() => load(cursor))}>
            下一页
          </button>
        )}
      </Panel>
      {selected && (
        <Panel
          title={selected.email}
          extra={<button onClick={() => setSelected(null)}>关闭</button>}
        >
          <form
            key={selected.id + ":" + selected.version}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task.run(async () => {
                const date = String(f.get("valid_until") || "");
                const v = await api("/admin/users/" + selected.id, "PATCH", {
                  version: selected.version,
                  module_grants: f.getAll("modules"),
                  max_sessions: Number(f.get("max_sessions")),
                  valid_until: date ? new Date(date).toISOString() : null,
                });
                setSelected(v.user);
                await load();
              });
            }}
          >
            <Grants initial={selected.module_grants} />
            <div className="grid">
              <Field label="并发会话上限">
                <input
                  type="number"
                  name="max_sessions"
                  min="1"
                  defaultValue={selected.max_sessions}
                  required
                />
              </Field>
              <Field label="有效期（本地时间）">
                <input
                  name="valid_until"
                  type="datetime-local"
                  defaultValue={
                    selected.valid_until
                      ? new Date(
                          new Date(selected.valid_until).getTime() -
                            new Date(selected.valid_until).getTimezoneOffset() *
                              60000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                />
              </Field>
            </div>
            <div className="actions">
              <button className="primary" disabled={task.busy}>
                保存授权
              </button>
              {["disable", "delete"].map((k) => (
                <button
                  key={k}
                  className="danger"
                  type="button"
                  disabled={task.busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "确认" +
                          (k === "delete" ? "删除" : "停用") +
                          " " +
                          selected.email +
                          "？该用户的会话将立即撤销。",
                      )
                    )
                      void task.run(async () => {
                        await api(
                          "/admin/users/" + selected.id + "/" + k,
                          "POST",
                          {},
                        );
                        setSelected(null);
                        await load();
                      });
                  }}
                >
                  {k === "delete" ? "删除账号" : "停用账号"}
                </button>
              ))}
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}
export function Connections({ actor }: { actor: Actor }) {
  const task = useTask(),
    [data, setData] = useState<any>({ shops: [], warehouses: [] });
  const load = async () => setData(await api("/connections"));
  useEffect(() => {
    void task.run(load);
  }, []);
  return (
    <>
      <Panel title="当前连接">
        <dl className="kv">
          <div>
            <dt>API 地址</dt>
            <dd>{apiOrigin}</dd>
          </div>
          <div>
            <dt>租户 ID</dt>
            <dd>{actor.tid}</dd>
          </div>
        </dl>
      </Panel>
      <Feedback task={task} />
      <Panel title="Noon 店铺">
        <form
          className="block"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void task.run(async () => {
              await api("/shop-connections", "POST", {
                name: f.get("name"),
                fulfillment_mode: f.get("mode"),
                credentials: JSON.parse(String(f.get("credentials"))),
              });
              form.reset();
              await load();
            });
          }}
        >
          <div className="grid">
            <Field label="店铺名称">
              <input name="name" required />
            </Field>
            <Field label="履约模式">
              <select name="mode">
                {["unknown", "fbpi", "fbn", "fbp"].map((m) => (
                  <option key={m} value={m}>
                    {m === "unknown" ? "待确认" : m.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="服务端连接凭证（JSON）">
            <input
              name="credentials"
              type="password"
              autoComplete="off"
              required
            />
          </Field>
          <div>
            <button className="primary" disabled={task.busy}>
              保存店铺连接
            </button>
          </div>
        </form>
        {data.shops.map((s: any) => (
          <div className="list-item" key={s.id}>
            <strong>{s.name}</strong> · {s.fulfillment_mode} · {s.status}
            <div className="toolbar">
              <button
                disabled={task.busy}
                onClick={() =>
                  void task.run(async () => {
                    await api(
                      "/shop-connections/" + s.id + "/verify",
                      "POST",
                      {},
                    );
                    await load();
                  })
                }
              >
                测试连接
              </button>
            </div>
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                void task.run(async () => {
                  await api("/shop-connections/" + s.id + "/rotate", "POST", {
                    version: s.version,
                    credentials: JSON.parse(String(f.get("new_credentials"))),
                  });
                  form.reset();
                  await load();
                });
              }}
            >
              <input
                name="new_credentials"
                aria-label="新凭证 JSON"
                placeholder="新凭证 JSON"
                type="password"
                autoComplete="off"
                required
              />
              <button disabled={task.busy}>更新本地凭证</button>
            </form>
          </div>
        ))}
      </Panel>
      <Panel title="中转仓">
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void task.run(async () => {
              await api("/warehouse-connections", "POST", {
                vendor_name: f.get("vendor_name"),
              });
              form.reset();
              await load();
            });
          }}
        >
          <input
            name="vendor_name"
            placeholder="供应商名称"
            aria-label="供应商名称"
            required
          />
          <button disabled={task.busy}>新增中转仓</button>
        </form>
        {data.warehouses.map((w: any) => (
          <form
            className="toolbar"
            key={w.id + ":" + w.version}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void task.run(async () => {
                await api("/warehouse-connections/" + w.id, "PATCH", {
                  version: w.version,
                  has_query: f.has("has_query"),
                  has_idempotency: f.has("has_idempotency"),
                });
                await load();
              });
            }}
          >
            <strong>{w.vendor_name}</strong>
            <label className="check">
              <input
                type="checkbox"
                name="has_query"
                defaultChecked={w.has_query}
              />
              支持查单
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="has_idempotency"
                defaultChecked={w.has_idempotency}
              />
              支持幂等
            </label>
            <button disabled={task.busy}>保存能力</button>
          </form>
        ))}
      </Panel>
      {actor.permissions.includes("team.manage") && <UserCreate team />}
    </>
  );
}
