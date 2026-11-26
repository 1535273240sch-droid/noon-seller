import { useState, useEffect } from "react";
import { ImagePlus, Download } from "lucide-react";
import { api, type Actor } from "./api";
import {
  Feedback,
  Empty,
  Field,
  Panel,
  statusText,
  useTask,
} from "./components";
import { downloadFile } from "./download";

async function upload(file: File) {
  if (
    !["image/png", "image/jpeg"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("请上传 10 MB 以内的 JPEG 或 PNG。");
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  return (
    await api("/uploads", "POST", {
      file_base64: base64,
      mime: file.type,
      copyright_ack: true,
    })
  ).source_id as string;
}
export function Assets({ actor }: { actor: Actor }) {
  const task = useTask(),
    can = actor.permissions.includes("assets.write"),
    cache = "image-job-" + actor.uid;
  const [files, setFiles] = useState<File[]>([]),
    [ack, setAck] = useState(false),
    [label, setLabel] = useState(""),
    [rows, setRows] = useState<any[]>([]),
    [jobs, setJobs] = useState<
      { id: string; status: string; created_at: string }[]
    >([]),
    [ids, setIds] = useState<string[]>([]),
    [balance, setBalance] = useState<number | null>(null),
    [job, setJob] = useState<any>(null),
    [preview, setPreview] = useState(""),
    [jobId, setJobId] = useState(() => sessionStorage.getItem(cache) || "");
  const library = async () => {
    const [a, q, j] = await Promise.all([
      api("/assets"),
      api("/quota"),
      api("/image-jobs"),
    ]);
    setRows(a.data);
    setJobs(j.data);
    setBalance(q.balance);
  };
  const inspect = async (id: string) => {
    const { job } = await api("/image-jobs/" + id);
    setJobId(id);
    sessionStorage.setItem(cache, id);
    setJob(job);
    setPreview(
      ["succeeded_pending_review", "confirmed"].includes(job.status)
        ? (await api("/image-jobs/" + id + "/preview")).url
        : "",
    );
  };
  useEffect(() => {
    void task.run(async () => {
      await library();
      if (jobId) await inspect(jobId);
    });
  }, []);
  const review = (action: string) =>
    void task.run(async () => {
      await api("/image-jobs/" + jobId + "/" + action, "POST", {
        version: job.version,
      });
      await inspect(jobId);
      await library();
    });
  return (
    <>
      <Feedback task={task} />
      <div className="columns">
        <Panel title="处理商品图">
          <form
            className="block"
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                if (!ack || !files.length || files.length > 4)
                  throw new Error("请选择 1 至 4 张原图并确认使用权。");
                const sources = [];
                for (const f of files) sources.push(await upload(f));
                const v = await api("/image-jobs", "POST", {
                  source_id: sources[0],
                  pipeline: [
                    "resize",
                    ...(sources.length > 1 ? ["collage"] : []),
                    ...(label ? ["overlay"] : []),
                  ],
                  extra_source_ids: sources.slice(1),
                  label,
                });
                setJobId(v.job_id);
                sessionStorage.setItem(cache, v.job_id);
                await inspect(v.job_id);
                await library();
              });
            }}
          >
            <Field label="原图（1–4 张，多张将拼图）">
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png"
                onChange={(e) => {
                  setFiles(Array.from(e.target.files || []));
                  setAck(false);
                }}
                required
              />
            </Field>
            <Field label="卖点文字（选填）">
              <input
                maxLength={64}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              我有权使用选中的图片
            </label>
            <div className="actions">
              <button
                className="primary"
                disabled={
                  !can ||
                  !ack ||
                  !files.length ||
                  files.length > 4 ||
                  task.busy ||
                  balance === 0
                }
              >
                <ImagePlus size={16} />
                生成主图
              </button>
              <small>每次 1 额度 · 可用 {balance ?? "—"}</small>
            </div>
          </form>
        </Panel>
        <Panel
          title="任务预览"
          extra={
            jobId && (
              <button onClick={() => void task.run(() => inspect(jobId))}>
                刷新
              </button>
            )
          }
        >
          {job ? (
            <>
              <span className="badge">{statusText(job.status)}</span>
              {job.error_code && <p>{job.error_code}</p>}
              {preview && (
                <img className="preview" src={preview} alt="待确认商品主图" />
              )}
              {job.status === "succeeded_pending_review" && (
                <div className="actions">
                  <button
                    className="primary"
                    disabled={!can || task.busy}
                    onClick={() => review("confirm")}
                  >
                    确认入库
                  </button>
                  <button
                    disabled={!can || task.busy}
                    onClick={() => review("discard")}
                  >
                    丢弃结果
                  </button>
                </div>
              )}
            </>
          ) : (
            <Empty>提交任务后可预览和审核结果。</Empty>
          )}
        </Panel>
      </div>
      <Panel
        title="最近处理任务"
        extra={<button onClick={() => void task.run(library)}>刷新列表</button>}
      >
        {jobs.length ? (
          jobs.map((item) => (
            <div className="list-item toolbar" key={item.id}>
              <span className="badge">{statusText(item.status)}</span>
              <time>{new Date(item.created_at).toLocaleString()}</time>
              <button onClick={() => void task.run(() => inspect(item.id))}>
                查看任务
              </button>
            </div>
          ))
        ) : (
          <Empty>暂无处理任务。</Empty>
        )}
      </Panel>
      <Panel
        title="素材库"
        extra={
          <button
            disabled={!ids.length || task.busy}
            onClick={() =>
              void task.run(() =>
                downloadFile(
                  "/v1/assets/bundle?ids=" + ids.join(","),
                  "assets.zip",
                ),
              )
            }
          >
            <Download size={15} />
            打包下载（{ids.length}）
          </button>
        }
      >
        {rows.length ? (
          rows.map((a) => (
            <div className="list-item toolbar" key={a.id}>
              <input
                type="checkbox"
                aria-label={"选中素材 " + a.id}
                checked={ids.includes(a.id)}
                disabled={!ids.includes(a.id) && ids.length >= 10}
                onChange={(e) =>
                  setIds(
                    e.target.checked
                      ? [...ids, a.id]
                      : ids.filter((x) => x !== a.id),
                  )
                }
              />
              <strong>
                {{
                  white: "白底图",
                  callout: "卖点图",
                  collage: "拼图",
                  scene: "场景图",
                }[String(a.kind)] || a.kind}
              </strong>
              <span>{new Date(a.approved_at).toLocaleString()}</span>
              <button
                onClick={() =>
                  void task.run(async () => {
                    const { url } = await api("/assets/" + a.id + "/download");
                    await chrome.tabs.create({ url });
                  })
                }
              >
                下载
              </button>
            </div>
          ))
        ) : (
          <Empty>审核通过的素材会保存在这里。</Empty>
        )}
      </Panel>
    </>
  );
}
export function Recommendations({ actor }: { actor: Actor }) {
  const task = useTask(),
    can = actor.permissions.includes("reco.write");
  const [result, setResult] = useState<any>(null),
    [sub, setSub] = useState<any>(null),
    [inbox, setInbox] = useState<any[]>([]),
    [site, setSite] = useState(""),
    [category, setCategory] = useState(""),
    [min, setMin] = useState(""),
    [max, setMax] = useState(""),
    [notice, setNotice] = useState("");
  const list = async () =>
    setResult(
      await api(
        "/recommendations?" +
          new URLSearchParams({
            site,
            category,
            min_price: min,
            max_price: max,
          }),
      ),
    );
  const settings = async () => {
    const [s, n] = await Promise.all([
      api("/reco-subscriptions/me"),
      api("/notifications"),
    ]);
    setSub(s.subscription);
    setInbox(n.data);
    return s.subscription;
  };
  useEffect(() => {
    void task.run(async () => {
      const s = await settings();
      if (s) {
        setSite(s.filters?.site || "");
        setCategory(s.filters?.category || "");
        setMin(String(s.filters?.min_price ?? ""));
        setMax(String(s.filters?.max_price ?? ""));
      }
      const params = new URLSearchParams(s?.filters || {});
      setResult(await api("/recommendations?" + params));
    });
  }, []);
  return (
    <>
      <Feedback task={task} />
      {notice && <p className="notice">{notice}</p>}
      <Panel
        title="推荐商品"
        extra={
          result?.source && (
            <span className="badge">{result.source.label} · 仅开发预览</span>
          )
        }
      >
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(list);
          }}
        >
          {[
            ["站点", site, setSite],
            ["类目", category, setCategory],
            ["最低价", min, setMin],
            ["最高价", max, setMax],
          ].map(([name, value, setter]) => (
            <input
              key={String(name)}
              aria-label={String(name)}
              placeholder={String(name)}
              value={String(value)}
              onChange={(e) => (setter as (s: string) => void)(e.target.value)}
            />
          ))}
          <button>筛选</button>
        </form>
        {result?.data?.length ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>商品</th>
                  <th>站点</th>
                  <th>类目</th>
                  <th>价格</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td>{r.site}</td>
                    <td>{r.category}</td>
                    <td>
                      {r.price} {r.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{result ? "没有匹配的商品。" : "等待可用数据源。"}</Empty>
        )}
      </Panel>
      <div className="columns">
        <Panel
          title="订阅条件"
          extra={
            sub && (
              <span className="badge">
                {sub.unsubscribed_at ? "已退订" : "已订阅"}
              </span>
            )
          }
        >
          <form
            key={sub?.version ?? 0}
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              void task.run(async () => {
                await api("/reco-subscriptions/me", "PUT", {
                  ...f,
                  version: sub?.version ?? 0,
                  filters: { site, category, min_price: min, max_price: max },
                });
                await settings();
                setNotice("订阅条件已保存。");
              });
            }}
          >
            <div className="grid">
              <Field label="推送频次">
                <select
                  name="frequency"
                  defaultValue={sub?.frequency ?? "daily"}
                >
                  <option value="daily">每日</option>
                  <option value="hourly">每小时</option>
                </select>
              </Field>
              <Field label="时区">
                <input
                  name="tz"
                  defaultValue={sub?.tz ?? "Asia/Shanghai"}
                  required
                />
              </Field>
              <Field label="免打扰开始">
                <input
                  name="dnd_start"
                  type="time"
                  defaultValue={sub?.dnd_start ?? "22:00"}
                />
              </Field>
              <Field label="免打扰结束">
                <input
                  name="dnd_end"
                  type="time"
                  defaultValue={sub?.dnd_end ?? "08:00"}
                />
              </Field>
            </div>
            <div className="actions">
              <button className="primary" disabled={!can || task.busy}>
                保存当前筛选与订阅
              </button>
              <button
                type="button"
                disabled={!can || !sub || sub.unsubscribed_at || task.busy}
                onClick={() =>
                  void task.run(async () => {
                    await api("/reco-subscriptions/me/unsubscribe", "POST", {});
                    await settings();
                    setNotice("已退订。");
                  })
                }
              >
                退订
              </button>
            </div>
          </form>
        </Panel>
        <Panel
          title="站内信箱"
          extra={
            <button
              onClick={() =>
                void task.run(async () => {
                  await settings();
                })
              }
            >
              刷新
            </button>
          }
        >
          {inbox.length ? (
            inbox.map((n) => (
              <div key={n.id} className="list-item">
                <strong>{n.payload.title}</strong>{" "}
                {n.quiet && <small>免打扰入箱</small>}{" "}
                <button
                  disabled={!!n.read_at}
                  onClick={() =>
                    void task.run(async () => {
                      await api(
                        "/notifications/" + n.id + "/read",
                        "PATCH",
                        {},
                      );
                      await settings();
                      setSite(n.payload.site || "");
                      setResult(
                        await api(
                          "/recommendations?site=" +
                            encodeURIComponent(n.payload.site || ""),
                        ),
                      );
                      window.scrollTo(0, 0);
                    })
                  }
                >
                  {n.read_at ? "已读" : "查看商品"}
                </button>
              </div>
            ))
          ) : (
            <Empty>暂无通知。</Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
