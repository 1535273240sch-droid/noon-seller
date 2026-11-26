import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Actor, apiError, CurrentActor, Permit, Public } from "../core";
import { IdentityService } from "./identity.service";

const cookie = "__Host-noon_refresh=";
const attributes = "; Path=/; Secure; HttpOnly; SameSite=None";
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Public()
  @Post("auth/login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { refresh, ...result } = await this.identity.login(body);
    reply.header(
      "Set-Cookie",
      cookie + refresh + attributes + "; Max-Age=2592000",
    );
    reply.header("Cache-Control", "no-store");
    return result;
  }
  @Public()
  @Post("auth/refresh")
  @HttpCode(200)
  refresh(
    @Headers("cookie") cookies = "",
    @Headers("x-noon-refresh") marker: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (marker !== "1")
      throw apiError(403, "FORBIDDEN", "刷新请求缺少客户端标记");
    const value = cookies
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookie));
    reply.header("Cache-Control", "no-store");
    return this.identity.refresh(value?.slice(cookie.length) ?? "");
  }
  @Post("auth/logout")
  @HttpCode(204)
  async logout(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.identity.revoke(actor, key, actor.sid);
    reply.header("Set-Cookie", cookie + attributes + "; Max-Age=0");
  }
  @Get("auth/me") me(@CurrentActor() actor: Actor) {
    return { actor };
  }
  @Permit("admin.manage")
  @Get("admin/users")
  users(@Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.identity.listUsers(cursor, limit);
  }
  @Permit("admin.manage")
  @Post("admin/users")
  create(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.identity.createUser(actor, key, body);
  }
  @Permit("admin.manage")
  @Get("admin/users/:id/sessions")
  sessions(
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.identity.sessions(id, cursor, limit);
  }
  @Permit("team.manage")
  @Post("team/users")
  invite(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.identity.createUser(actor, key, body, true);
  }
  @Permit("admin.manage")
  @Patch("admin/users/:id")
  update(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.identity.updateUser(actor, id, body);
  }
  @Permit("admin.manage")
  @Post("admin/users/:id/disable")
  @HttpCode(200)
  disable(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return this.identity.changeStatus(actor, key, id, "disabled");
  }
  @Permit("admin.manage")
  @Post("admin/users/:id/delete")
  @HttpCode(200)
  remove(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return this.identity.changeStatus(actor, key, id, "deleted");
  }
  @Post("sessions/:id/revoke")
  @HttpCode(200)
  revoke(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return this.identity.revoke(actor, key, id);
  }
  @Permit("admin.manage") @Get("admin/stats") stats() {
    return this.identity.stats();
  }
  @Permit("team.manage")
  @Post("team/read-grants")
  grantRead(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.identity.grantRead(actor, key, body);
  }
  @Permit("team.manage")
  @Post("team/read-grants/:id/revoke")
  @HttpCode(200)
  revokeRead(
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return this.identity.revokeRead(actor, key, id);
  }
  @Permit("admin.manage")
  @Post("auth/read-grants/:id/access")
  @HttpCode(200)
  useGrant(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.identity.useGrant(actor, id);
  }
}
