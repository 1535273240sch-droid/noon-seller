import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Actor, Tx } from "../core";
import { Db, apiError } from "../core";
import {
  development,
  filters,
  Filters,
  isQuiet,
  subscriptionInput,
  uuid,
} from "./rules";

export const demoSource = "development-fixtures";
type DemoItem = {
  external_id: string;
  title: string;
  category: string;
  site: string;
  price: string;
  currency: string;
};
const fixtures: DemoItem[] = [
  {
    external_id: "demo-desk",
    title: "桌面收纳盒",
    category: "收纳",
    site: "AE",
    price: "29.00",
    currency: "AED",
  },
  {
    external_id: "demo-travel",
    title: "旅行分装包",
    category: "旅行",
    site: "SA",
    price: "39.00",
    currency: "SAR",
  },
  {
    external_id: "demo-mat",
    title: "隔热餐垫",
    category: "厨房",
    site: "AE",
    price: "18.50",
    currency: "AED",
  },
];
export function sourceOrThrow() {
  if (!development())
    throw apiError(
      503,
      "SOURCE_UNAVAILABLE",
      "尚无正式推荐数据源，无法提供全站榜单",
    );
  return {
    id: demoSource,
    simulated: true,
    label: "模拟数据",
    acceptance_ready: false,
  };
}
function matches(item: DemoItem, criteria: Filters) {
  return (
    (!criteria.site || item.site === criteria.site) &&
    (!criteria.category || item.category === criteria.category) &&
    Number(item.price) >= (criteria.min_price ?? 0) &&
    Number(item.price) <= (criteria.max_price ?? Infinity)
  );
}
async function snapshot(tx: Tx, at: Date) {
  const source = sourceOrThrow();
  const day = at.toISOString().slice(0, 10);
  const contentHash = createHash("sha256")
    .update(JSON.stringify([day, fixtures]))
    .digest("hex");
  await tx.$executeRaw`INSERT INTO reco_sources(adapter_key,simulated,label) VALUES(${source.id},true,${source.label})
    ON CONFLICT DO NOTHING`;
  const [head] = await tx.$queryRaw<
    { id: string; fetched_at: Date }[]
  >`INSERT INTO reco_snapshots(source_id,fetched_at,tz,content_hash)
    VALUES(${source.id},${at},'UTC',${contentHash}) ON CONFLICT(source_id,content_hash) DO UPDATE
    SET content_hash=EXCLUDED.content_hash RETURNING id,fetched_at`;
  for (const item of fixtures) {
    await tx.$executeRaw`INSERT INTO reco_items(snapshot_id,source_id,external_id,time_bucket,title,category,site,price,currency)
      VALUES(${head.id}::uuid,${source.id},${item.external_id},${day}::date,${item.title},${item.category},
        ${item.site},${item.price}::numeric,${item.currency}) ON CONFLICT DO NOTHING`;
  }
  const data = await tx.$queryRaw<
    (DemoItem & { id: string })[]
  >`SELECT id,external_id,title,category,site,price::text,currency,
    image_url,sales_or_rank FROM reco_items WHERE snapshot_id=${head.id}::uuid ORDER BY external_id`;
  return {
    source,
    snapshot_id: head.id,
    collected_at: head.fetched_at,
    tz: "UTC",
    data,
  };
}

@Injectable()
export class Recommendations {
  constructor(private db: Db) {}
  async list(actor: Actor, query: any) {
    sourceOrThrow();
    const criteria = filters(query ?? {});
    return this.db.tenant(actor, async (tx) => {
      const result = await snapshot(tx, new Date());
      return {
        ...result,
        data: result.data.filter((item) => matches(item, criteria)),
      };
    });
  }
  subscription(actor: Actor) {
    return this.db.tenant(actor, async (tx) => {
      const [row] = await tx.$queryRaw<
        any[]
      >`SELECT filters,frequency,tz,to_char(dnd_start,'HH24:MI') AS dnd_start,
        to_char(dnd_end,'HH24:MI') AS dnd_end,unsubscribed_at,version FROM reco_subscriptions WHERE user_id=${actor.uid}::uuid`;
      return { subscription: row ?? null };
    });
  }
  save(actor: Actor, body: any) {
    const input = subscriptionInput(body);
    const expected = body.version ?? 0;
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw apiError(400, "VALIDATION", "无效的版本号");
    return this.db.tenant(actor, async (tx) => {
      // Serialize first-time saves too. A missing version means create-only.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.uid + ":reco-sub"},0))`;
      const [existing] = await tx.$queryRaw<
        { version: number }[]
      >`SELECT version FROM reco_subscriptions WHERE user_id=${actor.uid}::uuid FOR UPDATE`;
      if ((existing?.version ?? 0) !== expected)
        throw apiError(409, "VERSION_CONFLICT", "订阅已更新，请刷新");
      const [row] = await tx.$queryRaw<
        { id: string; version: number }[]
      >`INSERT INTO reco_subscriptions
        (tenant_id,user_id,filters,frequency,tz,dnd_start,dnd_end) VALUES(${actor.tid}::uuid,${actor.uid}::uuid,
          ${JSON.stringify(input.filters)}::jsonb,${input.frequency},${input.tz},${input.start}::time,${input.end}::time)
        ON CONFLICT(user_id) DO UPDATE SET filters=EXCLUDED.filters,frequency=EXCLUDED.frequency,tz=EXCLUDED.tz,
          dnd_start=EXCLUDED.dnd_start,dnd_end=EXCLUDED.dnd_end,unsubscribed_at=NULL,next_run_at=now(),
          version=reco_subscriptions.version+1 RETURNING id,version`;
      return row;
    });
  }
  unsubscribe(actor: Actor, key: string) {
    return this.db.write(
      actor,
      key,
      "reco-subscriptions/me/unsubscribe",
      {},
      async (tx) => {
        await tx.$executeRaw`UPDATE reco_subscriptions SET unsubscribed_at=now(),version=version+1
        WHERE user_id=${actor.uid}::uuid AND unsubscribed_at IS NULL`;
        return { subscribed: false };
      },
    );
  }
  inbox(actor: Actor) {
    return this.db.tenant(actor, async (tx) => ({
      data: await tx.$queryRaw<any[]>`SELECT id,payload,quiet,read_at,created_at
      FROM notifications WHERE user_id=${actor.uid}::uuid AND (${development()} OR payload->>'simulated'='false')
      ORDER BY created_at DESC,id LIMIT 100`,
    }));
  }
  read(actor: Actor, id: string) {
    if (!uuid(id)) throw apiError(404, "NOT_FOUND", "消息不可用");
    return this.db.tenant(actor, async (tx) => {
      const [notification] = await tx.$queryRaw<
        any[]
      >`UPDATE notifications SET read_at=coalesce(read_at,now())
        WHERE id=${id}::uuid AND user_id=${actor.uid}::uuid AND (${development()} OR payload->>'simulated'='false')
        RETURNING id,read_at,payload`;
      if (!notification) throw apiError(404, "NOT_FOUND", "消息不可用");
      return notification;
    });
  }
  async dispatch(actor: Actor) {
    if (!development()) return;
    await this.db.tenant(actor, async (tx) => {
      const due = await tx.$queryRaw<
        {
          id: string;
          user_id: string;
          filters: Filters;
          frequency: string;
          tz: string;
          dnd_start: string | null;
          dnd_end: string | null;
        }[]
      >`SELECT s.id,s.user_id,s.filters,s.frequency,s.tz,
        s.dnd_start::text,s.dnd_end::text FROM reco_subscriptions s JOIN users u ON u.id=s.user_id
        JOIN tenants t ON t.id=s.tenant_id WHERE s.unsubscribed_at IS NULL AND s.next_run_at<=now()
        AND u.status='active' AND u.tenant_id=s.tenant_id AND (u.valid_until IS NULL OR u.valid_until>now())
        AND 'reco'=ANY(t.modules) AND (u.role='tenant_admin' OR EXISTS(SELECT 1 FROM user_module_grants g
          WHERE g.user_id=u.id AND g.module='reco')) ORDER BY s.next_run_at LIMIT 16 FOR UPDATE OF s SKIP LOCKED`;
      if (!due.length) return;
      const now = new Date();
      const result = await snapshot(tx, now);
      for (const s of due) {
        const quiet = isQuiet(now, s.tz, s.dnd_start, s.dnd_end);
        for (const item of result.data.filter((i) => matches(i, s.filters))) {
          const payload = {
            title: item.title,
            site: item.site,
            price: item.price,
            currency: item.currency,
            item_id: item.id,
            source: demoSource,
            simulated: true,
            label: "模拟数据",
            page: "recommendations",
          };
          await tx.$executeRaw`INSERT INTO notifications(tenant_id,user_id,item_id,payload,quiet)
            VALUES(${actor.tid}::uuid,${s.user_id}::uuid,${item.id}::uuid,${JSON.stringify(payload)}::jsonb,
              ${quiet}) ON CONFLICT(user_id,item_id) DO NOTHING`;
        }
        const hours = s.frequency === "hourly" ? 1 : 24;
        await tx.$executeRaw`UPDATE reco_subscriptions SET next_run_at=now()+${hours}*interval '1 hour' WHERE id=${s.id}::uuid`;
      }
    });
  }
}
