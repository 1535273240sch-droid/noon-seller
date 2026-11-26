import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Db, Tx } from "./core";

export type Signals = { overdue_seconds: number; failed_recently: number };

export async function readQueueSignals(tx: Tx): Promise<Signals> {
  const [signals] = await tx.$queryRaw<Signals[]>`
    SELECT coalesce(greatest(0,extract(epoch FROM now()-min(due)))::int,0) AS overdue_seconds,
      (SELECT count(*)::int FROM queue_failures WHERE occurred_at >= now()-interval '5 minutes') AS failed_recently
    FROM (
      SELECT next_attempt_at AS due FROM commerce_outbox WHERE finished_at IS NULL
      UNION ALL
      SELECT CASE WHEN status='processing' THEN lease_until ELSE next_attempt_at END
      FROM image_jobs WHERE status IN ('queued','processing')
    ) AS pending`;
  return signals;
}
export function shouldAlert(signals: Signals) {
  return signals.overdue_seconds > 300 || signals.failed_recently > 20;
}

@Injectable()
export class QueueMonitor implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly log = new Logger(QueueMonitor.name);
  constructor(private readonly db: Db) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.check()
          .catch(() => this.log.error("Queue metrics unavailable"))
          .finally(() => {
            this.running = undefined;
          });
    }, 60000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }
  private async check() {
    const tenants = await this.db.client.$queryRaw<
      { id: string }[]
    >`SELECT id FROM tenants`;
    const total: Signals = { overdue_seconds: 0, failed_recently: 0 };
    for (const tenant of tenants) {
      const value = await this.db.client.$transaction(async (tx) => {
        await this.db.context(tx, tenant.id);
        await tx.$executeRaw`DELETE FROM queue_failures WHERE occurred_at < now()-interval '1 day'`;
        return readQueueSignals(tx);
      });
      total.overdue_seconds = Math.max(
        total.overdue_seconds,
        value.overdue_seconds,
      );
      total.failed_recently += value.failed_recently;
    }
    if (shouldAlert(total))
      this.log.error(
        JSON.stringify({ event: "queue_threshold_exceeded", ...total }),
      );
  }
}
