import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Db } from "../core";

@Injectable()
export class IdentityRetention implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: Db) {}
  onModuleInit() {
    const run = () =>
      this.purge().catch(() =>
        Logger.error("Identity retention failed", "IdentityRetention"),
      );
    void run();
    this.timer = setInterval(run, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async purge() {
    await this.db.client.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE api_idempotency i SET response=jsonb_set(i.response,'{user,email}',to_jsonb('deleted+' || u.id::text || '@invalid.local'))
        FROM users u WHERE u.status='deleted' AND u.deleted_at<now()-interval '30 days'
        AND i.scope IN ('admin:create','team:create') AND i.response #>> '{user,id}'=u.id::text
        AND i.response #>> '{user,email}' IS DISTINCT FROM 'deleted+' || u.id::text || '@invalid.local'`;
      await tx.$executeRaw`UPDATE users SET email='deleted+' || id::text || '@invalid.local',password_hash=NULL
        WHERE status='deleted' AND deleted_at<now()-interval '30 days' AND email <> 'deleted+' || id::text || '@invalid.local'`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE created_at<now()-interval '12 months'`;
      await tx.$executeRaw`DELETE FROM api_idempotency WHERE created_at<now()-interval '180 days'`;
    });
  }
}
