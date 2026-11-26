import { useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error };
}
export function Feedback({ task }: { task: ReturnType<typeof useTask> }) {
  return (
    <>
      {task.error && (
        <p className="error" role="alert">
          {task.error}
        </p>
      )}
      {task.busy && (
        <p className="progress" role="status">
          <LoaderCircle size={15} /> 正在处理…
        </p>
      )}
    </>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Panel({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {extra}
      </header>
      {children}
    </section>
  );
}
export function FormButton({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="submit" className="primary" disabled={disabled}>
      {children}
    </button>
  );
}
export function statusText(value: string) {
  return (
    (
      {
        queued: "已排队",
        running: "执行中",
        processing: "处理中",
        succeeded: "成功",
        succeeded_pending_review: "待审核",
        partial: "部分成功",
        failed: "失败",
        indeterminate: "待对账",
        needs_manual: "待人工处理",
        blocked_quantity: "待确认数量",
        ready: "可同步",
        submitted: "仓库已受理",
        tracking_updated: "已补运单",
        confirmed: "已入库",
        discarded: "已丢弃",
        active: "有效",
        disabled: "已停用",
        deleted: "已删除",
        reserved: "额度已预占",
      } as Record<string, string>
    )[value] || value
  );
}
