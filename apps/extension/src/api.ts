declare const __API_ORIGIN__: string;
export const apiOrigin = __API_ORIGIN__;
export type Actor = {
  uid: string;
  tid: string | null;
  role: string;
  permissions: string[];
  sid: string;
};
type Session = { access_token: string; actor: Actor };
let token = "";
let refreshing: Promise<Actor> | null = null;
export function forgetSession() {
  token = "";
}
export async function fetchBinary(path: string) {
  if (!path.startsWith("/v1/")) throw new Error("下载路径无效");
  const send = () =>
    fetch(apiOrigin + path, {
      credentials: "include",
      headers: { Authorization: "Bearer " + token },
    });
  let response = await send();
  if (response.status === 401) {
    await refresh();
    response = await send();
  }
  if (!response.ok) await decode(response);
  return response;
}
async function decode(response: Response) {
  if (response.status === 204) return null;
  const message = await response.json().catch(() => null);
  if (!response.ok) {
    const error = message?.error;
    throw new Error(
      [
        error?.message || response.statusText || "请求失败",
        error?.code,
        error?.request_id,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  return message;
}
function accept(session: Session) {
  token = session.access_token;
  return session.actor;
}
export function refresh(): Promise<Actor> {
  if (!refreshing)
    refreshing = fetch(apiOrigin + "/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "X-Noon-Refresh": "1" },
    })
      .then(decode)
      .then(accept)
      .finally(() => {
        refreshing = null;
      });
  return refreshing;
}
export async function login(email: string, password: string): Promise<Actor> {
  const res = await fetch(apiOrigin + "/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return accept(await decode(res));
}
export async function api(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD"].includes(method))
    headers["Idempotency-Key"] = crypto.randomUUID();
  const send = () =>
    fetch(apiOrigin + "/v1" + path, {
      method,
      credentials: "include",
      headers: { ...headers, Authorization: "Bearer " + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 401 && token) {
    try {
      await refresh();
    } catch {
      forgetSession();
      window.dispatchEvent(new Event("session-ended"));
      throw new Error("会话已结束，请重新登录。");
    }
    res = await send();
  }
  return decode(res);
}
