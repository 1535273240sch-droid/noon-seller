import { Module } from "@nestjs/common";
import { QuotesController } from "./quotes.controller";
import { OrdersController } from "./orders.controller";
import { CommerceWorker } from "./worker";

@Module({
  controllers: [QuotesController, OrdersController],
  providers: [CommerceWorker],
})
export class CommerceModule {}
