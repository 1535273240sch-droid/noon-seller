import { PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import { emailValue } from './identity.service';

async function bootstrap() {
  const email=emailValue(process.env.BOOTSTRAP_EMAIL);
  const password=process.env.BOOTSTRAP_PASSWORD;
  if (!password || password.length<16 || password.length>1024) throw new Error('BOOTSTRAP_PASSWORD requires 16–1024 characters');
  const db=new PrismaClient();
  try {
    const passwordHash=await hash(password,{type:argon2id});
    await db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1069113739)`;
      if (await tx.user.count({where:{role:'platform_admin'}})) throw new Error('Platform administrator already exists');
      await tx.user.create({data:{role:'platform_admin',email,passwordHash}});
    });
    console.log('平台管理员已创建。');
  } finally { await db.$disconnect(); }
}
bootstrap().catch(error=>{console.error(error.message);process.exitCode=1;});
