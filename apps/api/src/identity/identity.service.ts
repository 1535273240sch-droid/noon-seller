import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { argon2id, hash, verify } from "argon2";
import { createHash, randomBytes } from "node:crypto";
import {
  Actor,
  apiError,
  Db,
  delegatedActor,
  issueAccess,
  loadActor,
  moduleActions,
  Tx,
  uuid,
} from "../core";

type Input = Record<string, unknown>;
export function objectBody(value: unknown): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw apiError(400, "VALIDATION", "请求需要 JSON 对象");
  }
  return value as Input;
}
export function emailValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw apiError(400, "VALIDATION", "邮箱格式错误");
  return value.trim().toLowerCase();
}
export function checkedId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw apiError(400, "VALIDATION", "标识格式错误");
  return value;
}
function moduleList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !Object.hasOwn(moduleActions, v))
  ) {
    throw apiError(400, "VALIDATION", "模块列表无效");
  }
  return [...new Set(value as string[])].sort();
}
function maxSessions(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1000
  )
    throw apiError(400, "VALIDATION", "并发会话上限必须在 1 到 1000 之间");
  return value;
}
function expiry(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw apiError(400, "VALIDATION", "有效期需要带时区的 ISO 日期");
  return new Date(value);
}
const publicFields = {
  id: true,
  tenantId: true,
  email: true,
  role: true,
  status: true,
  validUntil: true,
  maxSessions: true,
  version: true,
  grants: { select: { module: true } },
} as const;
type UserView = Prisma.UserGetPayload<{ select: typeof publicFields }>;
function view(user: UserView) {
  return {
    id: user.id,
    tenant_id: user.tenantId,
    email: user.email,
    role: user.role,
    status: user.status,
    valid_until: user.validUntil?.toISOString() ?? null,
    max_sessions: user.maxSessions,
    version: user.version,
    module_grants: user.grants.map((g) => g.module).sort(),
  };
}
async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  resource: string,
  tid = actor.tid,
) {
  await tx.$executeRaw`INSERT INTO audit_logs(tenant_id,actor_id,action,resource)
    VALUES(${tid}::uuid,${actor.uid}::uuid,${action},${resource})`;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const rejected = () => apiError(401, "UNAUTHENTICATED", "登录凭据或会话无效");
async function trimSessions(tx: Tx, uid: string, limit: number) {
  await tx.$executeRaw`UPDATE sessions SET revoked_at=now() WHERE id IN (
    SELECT id FROM sessions WHERE user_id=${uid}::uuid AND expires_at>now() AND revoked_at IS NULL
    ORDER BY created_at DESC,id DESC OFFSET ${limit})`;
}
async function trimTenantSessions(tx: Tx, tid: string, limit: number) {
  await tx.$executeRaw`UPDATE sessions SET revoked_at=now() WHERE id IN (
    SELECT id FROM sessions WHERE tenant_id=${tid}::uuid AND expires_at>now() AND revoked_at IS NULL
    ORDER BY created_at DESC,id DESC OFFSET ${limit})`;
}

@Injectable()
export class IdentityService {
  constructor(private readonly db: Db) {}
  async login(input: unknown) {
    const body = objectBody(input);
    const email = emailValue(body.email);
    if (typeof body.password !== "string" || body.password.length > 1024)
      throw rejected();
    const match = await this.db.client.user.findUnique({
      where: { email },
      select: { id: true, tenantId: true, passwordHash: true },
    });
    if (
      !match?.passwordHash ||
      !(await verify(match.passwordHash, body.password))
    )
      throw rejected();
    return this.db.client.$transaction(async (tx) => {
      if (match.tenantId)
        await tx.$queryRaw`SELECT id FROM tenants WHERE id=${match.tenantId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM users WHERE id=${match.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: match.id },
        include: { tenant: true },
      });
      if (user.passwordHash !== match.passwordHash) throw rejected();
      const refresh = randomBytes(32).toString("base64url");
      const [session] = await tx.$queryRaw<
        Array<{ id: string }>
      >`INSERT INTO sessions
        (user_id,tenant_id,refresh_token_hash,created_at,expires_at)
        VALUES(${user.id}::uuid,${user.tenantId}::uuid,${digest(refresh)},clock_timestamp(),clock_timestamp()+interval '30 days') RETURNING id`;
      const actor = await loadActor(tx, session.id);
      await trimSessions(tx, user.id, user.maxSessions);
      if (user.tenant)
        await trimTenantSessions(tx, user.tenant.id, user.tenant.maxSessions);
      await audit(tx, actor, "login", session.id);
      return { refresh, actor, access_token: issueAccess(actor) };
    });
  }
  async refresh(refresh: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(refresh)) throw rejected();
    const session = await this.db.client.session.findUnique({
      where: { refreshTokenHash: digest(refresh) },
      select: { id: true },
    });
    if (!session) throw rejected();
    const actor = await loadActor(this.db.client, session.id);
    return { actor, access_token: issueAccess(actor) };
  }
  async createUser(actor: Actor, key: string, input: unknown, team = false) {
    const body = objectBody(input);
    const email = emailValue(body.email);
    const role = team ? "tenant_member" : body.role;
    if (
      (role !== "tenant_admin" && role !== "tenant_member") ||
      (team && body.role && body.role !== role)
    )
      throw apiError(400, "VALIDATION", "用户角色无效");
    const modules = moduleList(body.modules ?? body.module_grants ?? []);
    const max = maxSessions(body.max_sessions ?? 2);
    const validUntil = expiry(body.valid_until);
    const tid = team
      ? checkedId(actor.tid)
      : body.tenant_id == null
        ? null
        : checkedId(body.tenant_id);
    return this.db.write(
      actor,
      key,
      team ? "team:create" : "admin:create",
      body,
      async (tx) => {
        let tenant = tid
          ? await tx.tenant.findUnique({ where: { id: tid } })
          : null;
        if (tid && (!tenant || tenant.status !== "active"))
          throw apiError(404, "NOT_FOUND", "租户不可用");
        if (!tenant)
          tenant = await tx.tenant.create({
            data: {
              modules:
                role === "tenant_admin" ? modules : Object.keys(moduleActions),
              maxSessions: max,
            },
          });
        if (
          modules.some(
            (m) =>
              !tenant.modules.includes(m) ||
              (team && !actor.permissions.includes(m + ".read")),
          )
        )
          throw apiError(403, "FORBIDDEN", "超出租户模块范围");
        const pwd = randomBytes(18).toString("base64url");
        let user: UserView;
        try {
          user = await tx.user.create({
            data: {
              email,
              passwordHash: await hash(pwd, { type: argon2id }),
              role,
              tenantId: tenant.id,
              maxSessions: max,
              validUntil,
              grants: { create: modules.map((module) => ({ module })) },
            },
            select: publicFields,
          });
        } catch (e) {
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002"
          )
            throw apiError(409, "EMAIL_CONFLICT", "邮箱已存在");
          throw e;
        }
        await audit(
          tx,
          actor,
          team ? "team.invite" : "admin.create",
          user.id,
          tenant.id,
        );
        return { user: view(user), temporary_password: pwd };
      },
    );
  }
  async listUsers(cursor?: string, limit?: string) {
    const count = limit === undefined ? 50 : Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw apiError(400, "VALIDATION", "limit 应为 1–100");
    const rows = await this.db.client.user.findMany({
      where: {
        role: { not: "platform_admin" },
        ...(cursor ? { id: { gt: checkedId(cursor) } } : {}),
      },
      take: count + 1,
      orderBy: { id: "asc" },
      select: publicFields,
    });
    return {
      data: rows.slice(0, count).map(view),
      next_cursor: rows.length > count ? rows[count - 1].id : null,
    };
  }
  async updateUser(actor: Actor, id: string, input: unknown) {
    const body = objectBody(input);
    checkedId(id);
    if (!Number.isSafeInteger(body.version))
      throw apiError(400, "VALIDATION", "需要 version");
    const modules =
      body.module_grants === undefined
        ? undefined
        : moduleList(body.module_grants);
    const validUntil =
      body.valid_until === undefined ? undefined : expiry(body.valid_until);
    const max =
      body.max_sessions === undefined
        ? undefined
        : maxSessions(body.max_sessions);
    return this.db.client.$transaction(async (tx) => {
      // Logins acquire the tenant lock first. Keep this order while editing caps.
      const target = await tx.user.findUnique({
        where: { id },
        select: { role: true, tenantId: true },
      });
      if (target?.role === "tenant_admin" && target.tenantId) {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id=${target.tenantId}::uuid FOR UPDATE`;
      }
      const count = await tx.user.updateMany({
        where: {
          id,
          role: { not: "platform_admin" },
          version: Number(body.version),
          status: { not: "deleted" },
        },
        data: { validUntil, maxSessions: max, version: { increment: 1 } },
      });
      if (!count.count)
        throw apiError(409, "VERSION_CONFLICT", "用户版本已变化或不可编辑");
      const user = await tx.user.findUniqueOrThrow({
        where: { id },
        include: { tenant: true },
      });
      if (
        user.role === "tenant_admin" &&
        user.tenantId &&
        (modules !== undefined || max !== undefined)
      ) {
        await tx.tenant.update({
          where: { id: user.tenantId },
          data: { modules, maxSessions: max, version: { increment: 1 } },
        });
        if (max !== undefined) await trimTenantSessions(tx, user.tenantId, max);
      }
      if (modules) {
        if (
          user.role !== "tenant_admin" &&
          modules.some((m) => !user.tenant?.modules.includes(m))
        )
          throw apiError(403, "FORBIDDEN", "超出租户模块范围");
        await tx.userModuleGrant.deleteMany({ where: { userId: id } });
        if (modules.length)
          await tx.userModuleGrant.createMany({
            data: modules.map((module) => ({ userId: id, module })),
          });
      }
      if (max !== undefined) await trimSessions(tx, id, max);
      await audit(tx, actor, "admin.update", id, user.tenantId);
      return {
        user: view(
          await tx.user.findUniqueOrThrow({
            where: { id },
            select: publicFields,
          }),
        ),
      };
    });
  }
  async sessions(id: string, cursor?: string, limit?: string) {
    checkedId(id);
    const count = limit === undefined ? 50 : Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw apiError(400, "VALIDATION", "limit 应为 1–100");
    const user = await this.db.client.user.findFirst({
      where: { id, role: { not: "platform_admin" } },
      select: { id: true },
    });
    if (!user) throw apiError(404, "NOT_FOUND", "用户不可用");
    const rows = await this.db.client.session.findMany({
      where: { userId: id },
      ...(cursor ? { cursor: { id: checkedId(cursor) }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: count + 1,
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
    });
    return {
      data: rows
        .slice(0, count)
        .map((r) => ({
          id: r.id,
          created_at: r.createdAt,
          expires_at: r.expiresAt,
          revoked_at: r.revokedAt,
        })),
      next_cursor: rows.length > count ? rows[count - 1].id : null,
    };
  }
  changeStatus(
    actor: Actor,
    key: string,
    id: string,
    status: "disabled" | "deleted",
  ) {
    checkedId(id);
    return this.db.write(
      actor,
      key,
      "admin:" + status + ":" + id,
      {},
      async (tx) => {
        const updated = await tx.user.updateMany({
          where: {
            id,
            role: { not: "platform_admin" },
            status: { not: "deleted" },
          },
          data: {
            status,
            version: { increment: 1 },
            ...(status === "deleted"
              ? { deletedAt: new Date(), passwordHash: null }
              : {}),
          },
        });
        if (!updated.count) throw apiError(404, "NOT_FOUND", "用户不可用");
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { id },
          select: { tenantId: true },
        });
        await audit(tx, actor, "admin." + status, id, user.tenantId);
        return { id, status };
      },
    );
  }
  revoke(actor: Actor, key: string, id: string) {
    checkedId(id);
    return this.db.write(actor, key, "session:revoke:" + id, {}, async (tx) => {
      const session = await tx.session.findFirst({
        where: {
          id,
          ...(actor.role === "platform_admin" ? {} : { userId: actor.uid }),
        },
      });
      if (!session) throw apiError(404, "NOT_FOUND", "会话不可用");
      await tx.session.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(tx, actor, "session.revoke", id, session.tenantId);
      return { revoked: true };
    });
  }
  async stats() {
    const [tenants, users, activeSessions] = await this.db.client.$transaction([
      this.db.client.tenant.count({ where: { status: "active" } }),
      this.db.client.user.count({
        where: { role: { not: "platform_admin" }, status: "active" },
      }),
      this.db.client.session.count({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    return { tenants, users, active_sessions: activeSessions };
  }
  grantRead(actor: Actor, key: string, input: unknown) {
    const body = objectBody(input),
      admin = checkedId(body.admin_id);
    const permission = body.permission,
      reason = body.reason,
      minutes = body.minutes;
    if (
      typeof permission !== "string" ||
      !actor.permissions.includes(permission) ||
      !["orders.read", "quotes.read", "assets.read", "reco.read"].includes(
        permission,
      ) ||
      typeof reason !== "string" ||
      !["support_ticket", "incident_review", "reconciliation"].includes(
        reason,
      ) ||
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 60
    )
      throw apiError(
        400,
        "VALIDATION",
        "需要模块查看权限、授权原因和 1–60 分钟有效期",
      );
    return this.db.write(actor, key, "delegation.grant", body, async (tx) => {
      const target = await tx.user.findFirst({
        where: { id: admin, role: "platform_admin", status: "active" },
      });
      if (!target) throw apiError(404, "NOT_FOUND", "平台用户不可用");
      const [grant] = await tx.$queryRaw<
        Array<{ id: string; expires_at: Date }>
      >`INSERT INTO break_glass_grants
        (tenant_id,admin_id,authorized_by,permission,reason,expires_at) VALUES(${actor.tid}::uuid,
        ${admin}::uuid,${actor.uid}::uuid,${permission},${reason},now()+make_interval(mins=>${minutes}::int))
        RETURNING id,expires_at`;
      await audit(tx, actor, "delegation.grant", grant.id);
      return grant;
    });
  }
  revokeRead(actor: Actor, key: string, id: string) {
    checkedId(id);
    return this.db.write(
      actor,
      key,
      "delegation.revoke:" + id,
      {},
      async (tx) => {
        const updated =
          await tx.$executeRaw`UPDATE break_glass_grants SET revoked_at=coalesce(revoked_at,now())
        WHERE id=${id}::uuid AND tenant_id=${actor.tid}::uuid`;
        if (!updated) throw apiError(404, "NOT_FOUND", "授权不可用");
        await audit(tx, actor, "delegation.revoke", id);
        return { revoked: true };
      },
    );
  }
  async useGrant(actor: Actor, id: string) {
    const delegated = await delegatedActor(
      this.db.client,
      actor,
      checkedId(id),
    );
    return { actor: delegated, access_token: issueAccess(delegated) };
  }
}
