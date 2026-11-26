import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

const origin = new URL(process.env.SMOKE_API_ORIGIN || "http://127.0.0.1:3100");
if (
  !["localhost", "127.0.0.1"].includes(origin.hostname) ||
  process.env.APP_ENV !== "dev"
)
  throw new Error(
    "Use a disposable local development database with the mock warehouse.",
  );
const count = 1000,
  batchSize = 50,
  readers = 50;
async function request(
  path,
  token,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const res = await fetch(new URL("/v1" + path, origin), {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(path + " " + res.status + " " + result.error?.code);
  return result;
}
async function mapLimit(items, limit, action) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, limit) }, async () => {
      while (index < items.length) {
        const i = index++;
        results[i] = await action(items[i], i);
      }
    }),
  );
  return results;
}
const range = (n) => Array.from({ length: n }, (_, i) => i);
async function poll(fn) {
  const end = performance.now() + 240000;
  while (performance.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(300);
  }
  throw new Error("Polling deadline exceeded");
}
const admin = (
  await request("/auth/login", null, {
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
  })
).access_token;
const tag = randomUUID(),
  created = [];
async function createUser(i, tenant) {
  const email = "bench-" + tag + "-" + i + "@example.invalid";
  const user = await request("/admin/users", admin, {
    email,
    role: tenant ? "tenant_member" : "tenant_admin",
    modules: ["orders"],
    max_sessions: tenant ? 2 : readers,
    ...(tenant ? { tenant_id: tenant } : {}),
  });
  created.push(user.user.id);
  return {
    tenant: user.user.tenant_id,
    token: (
      await request("/auth/login", null, {
        email,
        password: user.temporary_password,
      })
    ).access_token,
  };
}
try {
  const seller = await createUser(0);
  await mapLimit(range(Math.ceil(count / 3)), 8, (i) =>
    request("/dev/orders", seller.token, { order_nr: tag + "-" + i }),
  );
  const rows = await poll(async () => {
    const result = [];
    let cursor = "";
    do {
      const page = await request(
        "/orders?limit=100&cursor=" + encodeURIComponent(cursor),
        seller.token,
      );
      result.push(
        ...page.data.flatMap((o) =>
          o.lines.map((l) => ({ order: o.id, line: l })),
        ),
      );
      cursor = page.next_cursor;
    } while (cursor);
    return result.length >= count && result.slice(0, count);
  });
  await mapLimit(rows, 8, (row) =>
    request(
      "/orders/" + row.order + "/lines/" + row.line.id,
      seller.token,
      { quantity: "2", version: row.line.version },
      "PATCH",
    ),
  );
  let submitted = 0;
  const times = [];
  for (let from = 0; from < rows.length; from += batchSize) {
    const start = performance.now();
    const { batch } = await request("/sync-batches", seller.token, {
      order_line_ids: rows.slice(from, from + batchSize).map((r) => r.line.id),
    });
    const status = await poll(async () => {
      const { batch: b } = await request(
        "/sync-batches/" + batch.id,
        seller.token,
      );
      return !["queued", "running"].includes(b.status) && b;
    });
    submitted += status.succeeded;
    times.push(Math.round(performance.now() - start));
  }
  const sessions = await mapLimit(range(readers - 1), 2, (i) =>
    createUser(i + 1, seller.tenant),
  );
  const all = [seller, ...sessions];
  const listTimes = await Promise.all(
    all.map(async (user) => {
      const start = performance.now();
      await request("/orders?limit=50", user.token);
      return performance.now() - start;
    }),
  );
  const ordered = listTimes.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        environment: "local dev mock",
        denominator: count,
        submitted,
        batch_size: batchSize,
        batches: times.length,
        max_batch_ms: Math.max(...times),
        first_batch_ms: times[0],
        independent_readers: all.length,
        list_p95_ms: Math.round(ordered[Math.ceil(all.length * 0.95) - 1]),
      },
      null,
      2,
    ),
  );
  assert.equal(submitted, count);
} finally {
  await mapLimit(created, 3, (id) =>
    request("/admin/users/" + id + "/delete", admin, {}),
  );
}
