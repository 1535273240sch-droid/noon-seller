import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Actor, CurrentActor, Db, Permit } from "../core";
import { Images } from "./images.service";
import { ObjectStore } from "./objects";
import { Recommendations } from "./recommendations.service";

@Controller()
class CatalogController {
  constructor(
    private images: Images,
    private reco: Recommendations,
  ) {}
  @Post("uploads")
  @Permit("assets.write")
  upload(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.images.upload(a, key, body);
  }
  @Get("quota")
  @Permit("assets.read")
  balance(@CurrentActor() a: Actor) {
    return this.images.quota(a);
  }
  @Post("image-jobs")
  @HttpCode(202)
  @Permit("assets.write")
  start(
    @CurrentActor() a: Actor,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.images.create(a, key, body);
  }
  @Get("image-jobs")
  @Permit("assets.read")
  recentJobs(@CurrentActor() actor: Actor) {
    return this.images.listJobs(actor);
  }
  @Get("image-jobs/:id")
  @Permit("assets.read")
  status(@CurrentActor() a: Actor, @Param("id") id: string) {
    return this.images.show(a, id);
  }
  @Get("image-jobs/:id/preview")
  @Permit("assets.read")
  preview(@CurrentActor() a: Actor, @Param("id") id: string) {
    return this.images.preview(a, id);
  }
  @Post("image-jobs/:id/confirm")
  @HttpCode(200)
  @Permit("assets.write")
  confirm(
    @CurrentActor() a: Actor,
    @Param("id") id: string,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.images.review(a, id, key, body, true);
  }
  @Post("image-jobs/:id/discard")
  @HttpCode(200)
  @Permit("assets.write")
  discard(
    @CurrentActor() a: Actor,
    @Param("id") id: string,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return this.images.review(a, id, key, body, false);
  }
  @Get("assets")
  @Permit("assets.read")
  listAssets(@CurrentActor() a: Actor) {
    return this.images.list(a);
  }
  @Get("assets/:id/download")
  @Permit("assets.read")
  download(@CurrentActor() a: Actor, @Param("id") id: string) {
    return this.images.download(a, id);
  }
  @Get("assets/bundle")
  @Permit("assets.read")
  async bundle(
    @CurrentActor() a: Actor,
    @Query("ids") csv: string,
    @Res() reply: FastifyReply,
  ) {
    const data = await this.images.bundle(
      a,
      typeof csv === "string" ? csv.split(",") : [],
    );
    return reply
      .type("application/zip")
      .header("Content-Disposition", 'attachment; filename="noon-assets.zip"')
      .send(data);
  }
  @Get("recommendations")
  @Permit("reco.read")
  recommendations(@CurrentActor() a: Actor, @Query() query: unknown) {
    return this.reco.list(a, query);
  }
  @Get("reco-subscriptions/me")
  @Permit("reco.read")
  subscription(@CurrentActor() a: Actor) {
    return this.reco.subscription(a);
  }
  @Put("reco-subscriptions/me")
  @Permit("reco.write")
  save(@CurrentActor() a: Actor, @Body() body: unknown) {
    return this.reco.save(a, body);
  }
  @Post("reco-subscriptions/me/unsubscribe")
  @HttpCode(200)
  @Permit("reco.write")
  stop(@CurrentActor() a: Actor, @Headers("idempotency-key") key: string) {
    return this.reco.unsubscribe(a, key);
  }
  @Get("notifications")
  @Permit("reco.read")
  inbox(@CurrentActor() a: Actor) {
    return this.reco.inbox(a);
  }
  @Patch("notifications/:id/read")
  @Permit("reco.read")
  read(@CurrentActor() a: Actor, @Param("id") id: string) {
    return this.reco.read(a, id);
  }
}

@Injectable()
class CatalogWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CatalogWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private active?: Promise<void>;
  private stopped = false;
  private after = "00000000-0000-0000-0000-000000000000";
  constructor(
    private db: Db,
    private images: Images,
    private reco: Recommendations,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.running || this.stopped) return;
      this.running = true;
      this.active = this.cycle()
        .catch(() =>
          this.log.error("Catalog worker could not scan active tenants"),
        )
        .finally(() => {
          this.running = false;
        });
    }, 2000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
  }
  private async cycle() {
    const tenants = await this.db.client.$queryRaw<
      { id: string; modules: string[] }[]
    >`SELECT id,modules FROM tenants
      WHERE status='active' AND (valid_until IS NULL OR valid_until>now()) AND id>${this.after}::uuid ORDER BY id LIMIT 32`;
    for (const tenant of tenants) {
      if (this.stopped) return;
      const actor: Actor = {
        tid: tenant.id,
        uid: "",
        sid: "",
        permissions: [],
        role: "tenant_member",
      };
      try {
        if (tenant.modules.includes("assets"))
          await this.images.processOne(actor);
        if (tenant.modules.includes("reco")) await this.reco.dispatch(actor);
      } catch {
        this.log.warn("Catalog job deferred until next pass");
      }
      this.after = tenant.id;
    }
    if (tenants.length < 32)
      this.after = "00000000-0000-0000-0000-000000000000";
  }
}

@Module({
  controllers: [CatalogController],
  providers: [Images, ObjectStore, Recommendations, CatalogWorker],
})
export class CatalogModule {}
