import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, StreamableFile } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { map } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { Db, signingKey } from './core';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const http=host.switchToHttp();
    const request_id=http.getRequest<FastifyRequest>().id;
    const reply=http.getResponse<FastifyReply>();
    let status=500, details:unknown={}, message='服务暂不可用', code='INTERNAL';
    if (error instanceof HttpException) {
      status=error.getStatus();
      const body=error.getResponse();
      if (typeof body==='object' && 'error' in body && body.error && typeof body.error==='object') {
        const supplied=body.error as {code:string;message:string;details?:unknown};
        code=supplied.code;message=supplied.message;details=supplied.details ?? {};
      } else {code=status===404?'NOT_FOUND':'HTTP_ERROR';message=error.message;}
    } else if (typeof error==='object' && error!==null && 'statusCode' in error && error.statusCode===413) {
      status=413;code='PAYLOAD_TOO_LARGE';message='请求体超过大小限制';
    } else {
      Logger.error('Unhandled API error '+request_id+' ('+(error instanceof Error ? error.name : 'unknown')+')');
    }
    if (status===413) { code='PAYLOAD_TOO_LARGE';message='请求体超过大小限制'; }
    reply.status(status).send({error:{code,message,details,request_id}});
  }
}
async function main() {
  const stage=process.env.APP_ENV;
  if (!stage || !['dev','test','staging','prod'].includes(stage) ||
      (process.env.NODE_ENV==='production' && ['dev','test'].includes(stage))) {
    throw new Error('Set APP_ENV to dev, test, staging or prod; production NODE_ENV requires staging or prod');
  }
  signingKey();
  const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter({
    bodyLimit:15*1024*1024,genReqId:()=>randomUUID(),
  }));
  const origins=(process.env.CORS_ORIGINS ?? '').split(',').map(v=>v.trim()).filter(Boolean);
  if (origins.includes('*')) throw new Error('CORS_ORIGINS requires exact origins');
  app.enableCors({origin:origins,credentials:true,methods:['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
    allowedHeaders:['Authorization','Content-Type','Idempotency-Key','X-Noon-Refresh']});
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalInterceptors({intercept(ctx,next){
    const http=ctx.switchToHttp();
    const request_id=http.getRequest<FastifyRequest>().id;
    http.getResponse<FastifyReply>().header('X-Request-Id',request_id).header('Cache-Control','no-store');
    return next.handle().pipe(map(value=>
      value && typeof value==='object' && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof StreamableFile)
        ? {...value,request_id} : value));
  }});
  const db=app.get(Db);
  const [role]=await db.client.$queryRaw<Array<{unsafe:boolean}>>`
    SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname=current_user`;
  if (!role || role.unsafe) throw new Error('Runtime DATABASE_URL requires a nonsuperuser role without BYPASSRLS');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000),process.env.HOST ?? '127.0.0.1');
}
main().catch(error=>{console.error(error.message);process.exit(1);});
