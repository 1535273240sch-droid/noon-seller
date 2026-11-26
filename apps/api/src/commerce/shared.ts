import { Prisma } from "@prisma/client";
import { apiError, Tx } from "../core";
import { InputError } from "./pricing";

export function validate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InputError) throw apiError(422, err.code, err.message);
    throw err;
  }
}

export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw apiError(400, "VALIDATION", "无效的资源 ID");
  }
  return value.toLowerCase();
}

export function version(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2147483646
  )
    throw apiError(400, "VALIDATION", "需要有效的 version");
  return value;
}

export function pageSize(value?: string): number {
  if (value === undefined) return 50;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 100)
    throw apiError(400, "VALIDATION", "limit 范围为 1 至 100");
  return size;
}

export function page<T extends { id: string }>(rows: T[], size: number) {
  return {
    data: rows.slice(0, size),
    next_cursor: rows.length > size ? rows[size - 1].id : null,
  };
}

export function missing(): never {
  throw apiError(404, "NOT_FOUND", "找不到此资源");
}
export function conflict(): never {
  throw apiError(409, "VERSION_CONFLICT", "数据已更新，请刷新后重试");
}
export function demoMode() {
  return process.env.APP_ENV === "dev" || process.env.APP_ENV === "test";
}

export async function addTask(
  tx: Tx,
  tid: string,
  topic: string,
  resource: string,
) {
  await tx.$executeRaw`INSERT INTO commerce_outbox(tenant_id, topic, resource_id)
    VALUES (${tid}::uuid,${topic},${resource}::uuid)
    ON CONFLICT(tenant_id,topic,resource_id) DO UPDATE SET next_attempt_at=now(),finished_at=null`;
}

export const json = (value: unknown) =>
  Prisma.sql`${JSON.stringify(value)}::jsonb`;
