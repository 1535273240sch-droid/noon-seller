import {
  CanActivate, createParamDecorator, ExecutionContext, HttpException, Injectable,
  OnModuleDestroy, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export type Tx = Prisma.TransactionClient;
export type Role = 'platform_admin' | 'tenant_admin' | 'tenant_member';
export interface Actor {
  uid: string; tid: string | null; role: Role; permissions: string[]; sid: string;
  grant_id?: string;
}
export const moduleActions: Record<string, string[]> = {
  orders: ['orders.read','orders.sync'], quotes: ['quotes.read','quotes.write'],
  assets: ['assets.read','assets.write'], reco: ['reco.read','reco.write'],
  settings: ['settings.read','settings.write'],
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function apiError(status: number, code: string, message: string, details?: unknown) {
  return new HttpException({error: {code, message, details: details ?? {}}}, status);
}
const unauthenticated = () => apiError(401,'UNAUTHENTICATED','会话无效或已过期');
export const Public = () => SetMetadata('noon.public', true);
export const Permit = (permission: string) => SetMetadata('noon.permission', permission);
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor =>
  ctx.switchToHttp().getRequest().actor);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    return '{' + Object.keys(entry).sort().map(k => JSON.stringify(k) + ':' + canonical(entry[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export function signingKey(): string {
  const secret = process.env.JWT_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET must contain at least 32 bytes');
  return secret;
}
export function issueAccess(actor: Actor, now = Date.now()) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: actor.uid, sid: actor.sid, tid: actor.tid, grant:actor.grant_id,
    exp: Math.floor(now/1000) + 600, aud:'noon-api',
  })).toString('base64url');
  const data = header + '.' + payload;
  return data + '.' + createHmac('sha256',signingKey()).update(data).digest('base64url');
}
export function verifyAccess(token: string, now = Date.now()): Pick<Actor,'uid'|'tid'|'sid'|'grant_id'> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 2048) throw unauthenticated();
    const [h,p,s] = parts;
    const actual = Buffer.from(s,'base64url');
    const expected = createHmac('sha256',signingKey()).update(h + '.' + p).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw unauthenticated();
    const header = JSON.parse(Buffer.from(h,'base64url').toString());
    const claims = JSON.parse(Buffer.from(p,'base64url').toString());
    if (header.alg !== 'HS256' || claims.aud !== 'noon-api' || !uuid.test(claims.sid) ||
        !uuid.test(claims.sub) || (claims.tid !== null && !uuid.test(claims.tid)) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(now/1000)) throw unauthenticated();
    if (claims.grant!==undefined && !uuid.test(claims.grant)) throw unauthenticated();
    return {uid:claims.sub, tid:claims.tid, sid:claims.sid, ...(claims.grant?{grant_id:claims.grant}:{})};
  } catch { throw unauthenticated(); }
}

export async function delegatedActor(tx:Tx,actor:Actor,grantId:string) {
  if (actor.role!=='platform_admin' || actor.tid!==null) throw apiError(403,'FORBIDDEN','需要平台账号');
  const [grant]=await tx.$queryRaw<Array<{tenant_id:string;permission:string}>>`
    SELECT g.tenant_id,g.permission FROM break_glass_grants g JOIN tenants t ON t.id=g.tenant_id
    JOIN users u ON u.id=g.authorized_by
    WHERE g.id=${grantId}::uuid AND g.admin_id=${actor.uid}::uuid AND g.revoked_at IS NULL
    AND g.expires_at>now() AND t.status='active' AND (t.valid_until IS NULL OR t.valid_until>now())
    AND split_part(g.permission,'.',1)=ANY(t.modules) AND u.status='active'
    AND (u.valid_until IS NULL OR u.valid_until>now())`;
  if (!grant) throw apiError(403,'FORBIDDEN','临时授权不可用');
  return {...actor,tid:grant.tenant_id,permissions:[grant.permission],grant_id:grantId};
}

export async function loadActor(tx: Tx, sid: string): Promise<Actor> {
  const [row] = await tx.$queryRaw<Array<{uid:string; tid:string|null; role:Role; modules:string[]}>>`
    SELECT u.id AS uid,u.tenant_id AS tid,u.role,
      CASE WHEN u.role='tenant_admin' THEN t.modules ELSE ARRAY(
        SELECT module FROM user_module_grants WHERE user_id=u.id AND module=ANY(t.modules)
      ) END AS modules FROM sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN tenants t ON t.id=u.tenant_id
    WHERE s.id=${sid}::uuid AND s.revoked_at IS NULL AND s.expires_at>now()
      AND u.status='active' AND (u.valid_until IS NULL OR u.valid_until>now())
      AND s.tenant_id IS NOT DISTINCT FROM u.tenant_id
      AND (u.tenant_id IS NULL OR (t.status='active' AND (t.valid_until IS NULL OR t.valid_until>now())))`;
  if (!row) throw unauthenticated();
  const permissions = (row.modules ?? []).flatMap(m => moduleActions[m] ?? [])
    .filter(p => row.role !== 'tenant_member' || p !== 'settings.write');
  if (row.role === 'platform_admin') permissions.push('admin.manage');
  if (row.role === 'tenant_admin') permissions.push('team.manage');
  return {uid:row.uid, tid:row.tid, sid, role:row.role, permissions};
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly client = new PrismaClient();
  onModuleDestroy() { return this.client.$disconnect(); }
  async context(tx: Tx, tid: string | null) {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tid ?? ''}, true) AS tenant_id`;
  }
  tenant<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!actor.tid) throw apiError(403,'FORBIDDEN','需要租户身份');
    return this.client.$transaction(async tx => {
      await this.context(tx,actor.tid);
      return fn(tx);
    },{timeout:30000});
  }
  write<T>(actor: Actor, key: string | undefined, scope: string, body: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (typeof key !== 'string' || !/^[!-~]{1,200}$/.test(key)) {
      throw apiError(400,'VALIDATION','需要有效的 Idempotency-Key');
    }
    const lock = canonical([actor.uid,scope,key]);
    const fingerprint = createHash('sha256').update(canonical(body)).digest('hex');
    return this.client.$transaction(async tx => {
      await this.context(tx,actor.tid);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`;
      const [cached] = await tx.$queryRaw<Array<{fingerprint:string;response:T}>>`
        SELECT fingerprint,response FROM api_idempotency WHERE actor_id=${actor.uid}::uuid AND scope=${scope} AND key=${key}`;
      if (cached) {
        if (cached.fingerprint !== fingerprint) throw apiError(409,'IDEMPOTENCY_CONFLICT','同一幂等键的请求内容发生变化');
        return cached.response;
      }
      const result = await fn(tx);
      const stored = result && typeof result === 'object' && 'temporary_password' in result
        ? {...result,temporary_password:undefined} : result;
      const serialized = JSON.stringify(stored ?? null);
      await tx.$executeRaw`INSERT INTO api_idempotency(actor_id,scope,key,fingerprint,response)
        VALUES (${actor.uid}::uuid,${scope},${key},${fingerprint},${serialized}::jsonb)`;
      return result;
    },{timeout:30000});
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db:Db, private readonly reflector:Reflector) {}
  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(),context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('noon.public',targets)) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest & {actor:Actor}>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated();
    const claims = verifyAccess(header.slice(7));
    let actor = await loadActor(this.db.client,claims.sid);
    const permission = this.reflector.getAllAndOverride<string>('noon.permission',targets);
    if (claims.grant_id) {
      if (req.method!=='GET' || !permission?.endsWith('.read')) throw apiError(403,'FORBIDDEN','临时授权仅支持查看获准的模块');
      actor=await delegatedActor(this.db.client,actor,claims.grant_id);
      if (actor.permissions.includes(permission)) {
        await this.db.client.$executeRaw`INSERT INTO audit_logs(tenant_id,actor_id,action,resource,metadata)
          VALUES(${actor.tid}::uuid,${actor.uid}::uuid,'delegated.read',${req.routeOptions.url ?? permission},
          jsonb_build_object('grant_id',${claims.grant_id}::text,'request_id',${req.id}::text))`;
      }
    }
    if (claims.uid !== actor.uid || claims.tid !== actor.tid) throw unauthenticated();
    if (permission && !actor.permissions.includes(permission)) throw apiError(403,'FORBIDDEN','没有此操作的权限');
    const body = req.body as {tenant_id?:unknown}|null;
    if (body && Object.hasOwn(body,'tenant_id') && body.tenant_id !== actor.tid && permission !== 'admin.manage') {
      throw apiError(403,'TENANT_MISMATCH','租户与当前会话不一致');
    }
    req.actor = actor;
    return true;
  }
}
