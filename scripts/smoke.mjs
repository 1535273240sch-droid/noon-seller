import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const origin = new URL(process.env.SMOKE_API_ORIGIN || "http://127.0.0.1:3100");
if (
  !["localhost", "127.0.0.1"].includes(origin.hostname) ||
  process.env.APP_ENV !== "dev"
) {
  throw new Error(
    "Run against a local development API and disposable database.",
  );
}
async function call(path, method = "GET", body, token, headers = {}) {
  const response = await fetch(new URL("/v1" + path, origin), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Idempotency-Key": randomUUID(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  assert.ok(
    response.ok,
    method +
      " " +
      path +
      " " +
      response.status +
      " " +
      JSON.stringify(value.error),
  );
  return { response, value };
}
async function until(fn) {
  for (let i = 0; i < 35; i++) {
    const done = await fn();
    if (done) return done;
    await delay(1000);
  }
  throw new Error("Worker timeout");
}
const platform = (
  await call("/auth/login", "POST", {
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
  })
).value.access_token;
const email = "smoke-" + randomUUID() + "@example.invalid";
const created = (
  await call(
    "/admin/users",
    "POST",
    {
      email,
      role: "tenant_admin",
      modules: ["orders", "quotes", "assets", "reco", "settings"],
      max_sessions: 2,
    },
    platform,
  )
).value;
try {
  const session = await call("/auth/login", "POST", {
    email,
    password: created.temporary_password,
  });
  const token = session.value.access_token;
  assert.ok(token);
  const cookie = session.response.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  const renewed = await call("/auth/refresh", "POST", undefined, undefined, {
    Cookie: cookie.split(";")[0],
    "X-Noon-Refresh": "1",
  });
  assert.equal(renewed.value.actor.tid, created.user.tenant_id);
  const rule = {
    objective: "target_margin_on_price",
    tax_mode: "tax_on_price",
    commission_rate: "0.10",
    tax_rate: "0.05",
    target_rate: "0.20",
    rate_card: {
      first_weight_kg: "1",
      first_fee: "10",
      step_weight_kg: "1",
      step_fee: "0",
      zone_fee: "0",
    },
  };
  const body = {
    sku: "SMOKE-SKU",
    purchase_cost: "50",
    weight_kg: "1",
    rule,
    fx: {
      provider: "manual",
      base: "CNY",
      quote: "AED",
      rate: "0.50",
      fetched_at: new Date().toISOString(),
    },
  };
  const { quote } = (await call("/quotes/preview", "POST", body, token)).value;
  assert.deepEqual(
    [quote.selling_price, quote.commission, quote.tax, quote.implied_profit],
    ["46.15", "4.62", "2.31", "9.22"],
  );
  const id = randomUUID();
  await call(
    "/pricing-rules/" + id,
    "PUT",
    { ...rule, name: "Smoke", version: 0 },
    token,
  );
  await call(
    "/quotes",
    "POST",
    { ...body, rule_id: id, rule_version: 1 },
    token,
  );
  assert.equal(
    (await call("/quotes?sku=SMOKE-SKU", "GET", undefined, token)).value.data
      .length,
    1,
  );
  const reco = (await call("/recommendations", "GET", undefined, token)).value;
  assert.equal(reco.source.simulated, true);
  assert.equal(reco.source.acceptance_ready, false);
  const demo = (await call("/dev/orders", "POST", {}, token)).value;
  const o = await until(async () =>
    (await call("/orders", "GET", undefined, token)).value.data.find(
      (o) => o.fbpi_order_nr === demo.order_nr,
    ),
  );
  const line = o.lines[0];
  assert.equal(line.quantity, null);
  await call(
    "/orders/" + o.id + "/lines/" + line.id,
    "PATCH",
    { quantity: "2", version: line.version },
    token,
  );
  const { batch } = (
    await call("/sync-batches", "POST", { order_line_ids: [line.id] }, token)
  ).value;
  await until(
    async () =>
      (await call("/sync-batches/" + batch.id, "GET", undefined, token)).value
        .batch.status === "succeeded",
  );
  if (process.env.SMOKE_S3 === "1") {
    const { default: sharp } = await import("sharp");
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#fcfbf9" },
    })
      .png()
      .toBuffer();
    const src = (
      await call(
        "/uploads",
        "POST",
        {
          file_base64: image.toString("base64"),
          copyright_ack: true,
          mime: "image/png",
        },
        token,
      )
    ).value.source_id;
    const { job_id } = (
      await call(
        "/image-jobs",
        "POST",
        { source_id: src, pipeline: ["resize"] },
        token,
      )
    ).value;
    const job = await until(async () => {
      const v = (await call("/image-jobs/" + job_id, "GET", undefined, token))
        .value.job;
      assert.notEqual(v.status, "failed");
      return v.status === "succeeded_pending_review" && v;
    });
    const reviewed = (
      await call(
        "/image-jobs/" + job.id + "/confirm",
        "POST",
        { version: job.version },
        token,
      )
    ).value;
    const { url } = (
      await call(
        "/assets/" + reviewed.asset_id + "/download",
        "GET",
        undefined,
        token,
      )
    ).value;
    const result = await fetch(url);
    assert.equal(result.status, 200);
    const metadata = await sharp(
      Buffer.from(await result.arrayBuffer()),
    ).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height, metadata.density, metadata.format],
      [1200, 1200, 72, "jpeg"],
    );
    console.log(
      "S3 upload, worker, human approval and signed JPEG download passed.",
    );
  }
  console.log(
    "HTTP login, refresh, pricing, history, order sync and source labels passed.",
  );
} finally {
  await call(
    "/admin/users/" + created.user.id + "/delete",
    "POST",
    {},
    platform,
  );
}
