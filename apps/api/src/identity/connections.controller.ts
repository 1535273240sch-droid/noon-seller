import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Actor, apiError, CurrentActor, Db, Permit, Tx } from "../core";
import { checkedId, objectBody } from "./identity.service";
import { storeCredentials } from "./envelope";

type Shop = {
  id: string;
  name: string;
  fulfillment_mode: string;
  status: string;
  version: number;
};
type Warehouse = {
  id: string;
  vendor_name: string;
  has_query: boolean;
  has_idempotency: boolean;
  status: string;
  version: number;
};
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128)
    throw apiError(400, "VALIDATION", "名称应为 1–128 个字符");
  return value.trim();
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw apiError(400, "VALIDATION", "需要有效版本号");
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw apiError(400, "VALIDATION", "接口能力需要布尔值");
  return value;
}
function conflict() {
  throw apiError(409, "VERSION_CONFLICT", "连接不存在或已被更新");
}
async function audit(tx: Tx, a: Actor, action: string, id: string) {
  await tx.$executeRaw`INSERT INTO audit_logs(tenant_id,actor_id,action,resource)
    VALUES(${a.tid}::uuid,${a.uid}::uuid,${action},${id})`;
}
@Controller()
export class ConnectionsController {
  constructor(private readonly db: Db) {}
  @Get("connections")
  @Permit("settings.read")
  list(@CurrentActor() a: Actor) {
    return this.db.tenant(a, async (tx) => ({
      shops: await tx.$queryRaw<
        Shop[]
      >`SELECT id,name,fulfillment_mode,status,version FROM shop_connections ORDER BY name,id`,
      warehouses: await tx.$queryRaw<
        Warehouse[]
      >`SELECT id,vendor_name,has_query,has_idempotency,status,version FROM warehouse_connections ORDER BY vendor_name,id`,
    }));
  }
  @Post("shop-connections")
  @Permit("settings.write")
  createShop(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Body() raw: unknown,
  ) {
    const b = objectBody(raw),
      shopName = name(b.name),
      mode = b.fulfillment_mode ?? "unknown";
    if (
      typeof mode !== "string" ||
      !["unknown", "fbpi", "fbn", "fbp"].includes(mode)
    )
      throw apiError(400, "VALIDATION", "履约模型无效");
    return this.db.write(a, key, "shop.create", b, async (tx) => {
      const id = randomUUID(),
        cipher = storeCredentials(b.credentials, a.tid + "/shop/" + id);
      const [shop] = await tx.$queryRaw<
        Shop[]
      >`INSERT INTO shop_connections(id,tenant_id,name,fulfillment_mode,creds_enc)
        VALUES(${id}::uuid,${a.tid}::uuid,${shopName},${mode},${cipher}) ON CONFLICT(tenant_id,name) DO NOTHING
        RETURNING id,name,fulfillment_mode,status,version`;
      if (!shop) throw apiError(409, "NAME_CONFLICT", "店铺名称已存在");
      await audit(tx, a, "shop.create", id);
      return { shop };
    });
  }
  @Post("shop-connections/:id/verify")
  @HttpCode(200)
  @Permit("settings.write")
  async verify(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    checkedId(id);
    await this.db.write(a, key, "shop.verify:" + id, {}, async (tx) => {
      const [shop] = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM shop_connections WHERE id=${id}::uuid`;
      if (!shop) throw apiError(404, "NOT_FOUND", "连接不可用");
      await audit(tx, a, "shop.verify_unavailable", id);
      return { status: "unverified" };
    });
    throw apiError(
      503,
      "SOURCE_UNAVAILABLE",
      "等待 Noon Partner 授权和真实适配器联调",
      { status: "unverified" },
    );
  }
  @Post("shop-connections/:id/rotate")
  @HttpCode(200)
  @Permit("settings.write")
  rotateShop(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const b = objectBody(raw),
      v = version(b.version);
    checkedId(id);
    return this.db.write(a, key, "shop.rotate:" + id, b, async (tx) => {
      const cipher = storeCredentials(b.credentials, a.tid + "/shop/" + id);
      const [shop] = await tx.$queryRaw<
        Shop[]
      >`UPDATE shop_connections SET creds_enc=${cipher},version=version+1,
        status='unverified',updated_at=now() WHERE id=${id}::uuid AND version=${v} RETURNING id,name,fulfillment_mode,status,version`;
      if (!shop) conflict();
      await audit(tx, a, "shop.rotate", id);
      return { shop, provider_revocation: "unverified" };
    });
  }
  @Post("warehouse-connections")
  @Permit("settings.write")
  warehouse(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Body() raw: unknown,
  ) {
    const b = objectBody(raw),
      vendor = name(b.vendor_name),
      query = flag(b.has_query ?? false),
      dedup = flag(b.has_idempotency ?? false);
    return this.db.write(a, key, "warehouse.create", b, async (tx) => {
      const id = randomUUID(),
        cipher =
          b.credentials == null
            ? null
            : storeCredentials(b.credentials, a.tid + "/warehouse/" + id);
      const [warehouse] = await tx.$queryRaw<
        Warehouse[]
      >`INSERT INTO warehouse_connections(id,tenant_id,vendor_name,has_query,has_idempotency,creds_enc)
        VALUES(${id}::uuid,${a.tid}::uuid,${vendor},${query},${dedup},${cipher}) ON CONFLICT(tenant_id,vendor_name) DO NOTHING
        RETURNING id,vendor_name,has_query,has_idempotency,status,version`;
      if (!warehouse) throw apiError(409, "NAME_CONFLICT", "仓库名称已存在");
      await audit(tx, a, "warehouse.create", id);
      return { warehouse };
    });
  }
  @Patch("warehouse-connections/:id")
  @Permit("settings.write")
  capabilities(
    @CurrentActor() a: Actor,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const b = objectBody(raw),
      v = version(b.version),
      query = flag(b.has_query),
      dedup = flag(b.has_idempotency);
    checkedId(id);
    return this.db.tenant(a, async (tx) => {
      const [warehouse] = await tx.$queryRaw<
        Warehouse[]
      >`UPDATE warehouse_connections SET has_query=${query},
        has_idempotency=${dedup},status='unverified',version=version+1,updated_at=now() WHERE id=${id}::uuid AND version=${v}
        RETURNING id,vendor_name,has_query,has_idempotency,status,version`;
      if (!warehouse) conflict();
      await audit(tx, a, "warehouse.update", id);
      return { warehouse };
    });
  }
}
