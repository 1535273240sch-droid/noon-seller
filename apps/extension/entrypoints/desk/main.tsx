import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Anchor,
  ArrowUpRight,
  Boxes,
  Calculator,
  ChevronRight,
  Compass,
  Images,
  LogOut,
  Settings2,
  ShieldCheck,
  Waves,
} from "lucide-react";
import {
  api,
  apiOrigin,
  forgetSession,
  login,
  refresh,
  type Actor,
} from "../../src/api";
import { Feedback, Field, FormButton, useTask } from "../../src/components";
import { Orders } from "../../src/orders";
import { Quotes } from "../../src/quotes";
import { Assets, Recommendations } from "../../src/catalog";
import { Accounts, Connections } from "../../src/admin";
import "./style.css";

const pages = [
  {
    id: "orders",
    name: "订单",
    icon: Boxes,
    permission: "orders.read",
    heading: "订单同步",
    sub: "核对订单数量，跟踪仓库受理进度。",
  },
  {
    id: "quotes",
    name: "报价",
    icon: Calculator,
    permission: "quotes.read",
    heading: "跨境报价",
    sub: "按成本、运费和汇率计算售价，核对每一项费用。",
  },
  {
    id: "assets",
    name: "素材",
    icon: Images,
    permission: "assets.read",
    heading: "商品素材",
    sub: "处理原图，审核并保存商品主图。",
  },
  {
    id: "reco",
    name: "爆款",
    icon: Compass,
    permission: "reco.read",
    heading: "选品推荐",
    sub: "查看数据来源，管理订阅和站内通知。",
  },
  {
    id: "settings",
    name: "设置",
    icon: Settings2,
    permission: "settings.write",
    heading: "连接设置",
    sub: "查看当前账号、接口地址与履约连接。",
  },
  {
    id: "admin",
    name: "账号管理",
    icon: ShieldCheck,
    permission: "platform",
    heading: "账号管理",
    sub: "管理租户授权、有效期和会话。",
  },
] as const;
function Brand() {
  return (
    <div className="brand">
      <span className="symbol">
        <Waves size={26} />
      </span>
      <div>
        <strong>商渡</strong>
        <small>NOON SELLER</small>
      </div>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (a: Actor) => void }) {
  const task = useTask();
  return (
    <div className="login-shell">
      <section className="login-intro">
        <Brand />
        <div className="intro-text">
          <Anchor size={34} />
          <h1>
            Noon 卖家
            <br />
            工作台
          </h1>
          <p>订单同步、跨境报价与商品素材管理</p>
        </div>
        <div className="waves-art" aria-hidden="true" />
      </section>
      <section className="login-card">
        <h2>登录工作台</h2>
        <p className="muted">使用管理员分配的账号登录。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void task.run(async () =>
              onLogin(
                await login(
                  String(data.get("email")),
                  String(data.get("password")),
                ),
              ),
            );
          }}
        >
          <Field label="邮箱">
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              autoFocus
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <FormButton disabled={task.busy}>
            登录 <ArrowUpRight size={17} />
          </FormButton>
        </form>
        <Feedback task={task} />
        <small className="endpoint">{apiOrigin}</small>
      </section>
    </div>
  );
}
function Desk() {
  const [actor, setActor] = useState<Actor | null>(null),
    [starting, setStarting] = useState(true),
    [route, setRoute] = useState(location.hash.slice(1));
  const logout = useTask();
  useEffect(() => {
    void refresh()
      .then(setActor)
      .catch(() => {})
      .finally(() => setStarting(false));
    const hash = () => setRoute(location.hash.slice(1));
    const ended = () => setActor(null);
    window.addEventListener("hashchange", hash);
    window.addEventListener("session-ended", ended);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("session-ended", ended);
    };
  }, []);
  if (starting)
    return (
      <main className="boot">
        <Brand />
        <p>正在连接工作台…</p>
      </main>
    );
  if (!actor) return <Login onLogin={setActor} />;
  const visible = pages.filter((p) =>
    p.permission === "platform"
      ? actor.role === "platform_admin"
      : actor.role !== "platform_admin" &&
        actor.permissions.includes(p.permission),
  );
  const page = visible.find((p) => p.id === route) || visible[0];
  return (
    <div className="shell">
      <aside>
        <Brand />
        <nav aria-label="工作台导航">
          {visible.map((p) => (
            <a
              key={p.id}
              href={"#" + p.id}
              className={p.id === page?.id ? "selected" : ""}
            >
              <p.icon size={18} />
              {p.name}
            </a>
          ))}
        </nav>
        <button
          className="logout"
          disabled={logout.busy}
          onClick={() =>
            void logout.run(async () => {
              await api("/auth/logout", "POST");
              forgetSession();
              setActor(null);
            })
          }
        >
          <LogOut size={16} />
          退出登录
        </button>
      </aside>
      <main className="desk-content">
        <header className="top">
          <span>
            卖家工作台 <ChevronRight size={13} /> {page?.name ?? "账号"}
          </span>
          <span>
            <i className="dot" />
            {
              {
                tenant_admin: "租户管理员",
                tenant_member: "操作员",
                platform_admin: "平台管理员",
              }[actor.role]
            }
          </span>
        </header>
        <div className="page" key={page?.id}>
          <h1>{page?.heading ?? "暂无模块授权"}</h1>
          <p className="subtitle">
            {page?.sub ?? "请联系管理员开通业务模块。"}
          </p>
          <Feedback task={logout} />
          {page?.id === "orders" && <Orders actor={actor} />}{" "}
          {page?.id === "quotes" && <Quotes actor={actor} />}{" "}
          {page?.id === "assets" && <Assets actor={actor} />}{" "}
          {page?.id === "reco" && <Recommendations actor={actor} />}{" "}
          {page?.id === "settings" && <Connections actor={actor} />}{" "}
          {page?.id === "admin" && <Accounts />}
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Desk />);
