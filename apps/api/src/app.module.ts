import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Db, Public, SessionGuard } from './core';
import { IdentityController } from './identity/identity.controller';
import { ConnectionsController } from './identity/connections.controller';
import { IdentityService } from './identity/identity.service';
import { IdentityRetention } from './identity/retention';
import { CommerceModule } from './commerce/commerce.module';
import { CatalogModule } from './catalog/catalog.module';
import { QueueMonitor } from './operations';

@Global()
@Module({providers:[Db],exports:[Db]})
class DatabaseModule {}

@Controller('health')
class HealthController {
  constructor(private readonly db:Db) {}
  @Public() @Get()
  async check() { await this.db.client.$queryRaw`SELECT 1`; return {status:'ok'}; }
}
@Module({imports:[DatabaseModule,CommerceModule,CatalogModule],
  controllers:[IdentityController,ConnectionsController,HealthController],
  providers:[IdentityService,IdentityRetention,QueueMonitor,{provide:APP_GUARD,useClass:SessionGuard}]})
export class AppModule {}
