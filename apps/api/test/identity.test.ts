import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { argon2id, hash } from 'argon2';
import { Actor, Db, delegatedActor, issueAccess, loadActor, verifyAccess } from '../src/core';
import { IdentityService } from '../src/identity/identity.service';

process.env.JWT_SECRET ??= 'test-only-key-for-isolated-test-process';
const actor:Actor={uid:randomUUID(),tid:randomUUID(),sid:randomUUID(),role:'tenant_member',permissions:['quotes.read']};
test('short access token binds subject, session and tenant, rejects changes and expires after ten minutes',()=>{
  const value=issueAccess(actor,0);
  assert.deepEqual(verifyAccess(value,599999),{uid:actor.uid,tid:actor.tid,sid:actor.sid});
  assert.throws(()=>verifyAccess(value,600000));
  const [header,payload,signature]=value.split('.');
  assert.throws(()=>verifyAccess(header+'.'+payload+'a.'+signature,0));
});

const dbUrl=process.env.TEST_DATABASE_URL;
test('T-F3-01–06 persisted identity, concurrency, scoped grants and tenant boundary',
  {skip:!dbUrl,timeout:60000},async t=>{
    // Use only an explicitly supplied, migrated test database with a runtime role.
    process.env.DATABASE_URL=dbUrl;
    const db=new Db(), service=new IdentityService(db);
    t.after(()=>db.onModuleDestroy());
    const password=randomUUID(), tag=randomUUID();
    const owner=await db.client.user.create({data:{email:tag+'@admin.invalid',role:'platform_admin',
      passwordHash:await hash(password,{type:argon2id})}});
    const platform=(await service.login({email:owner.email,password})).actor;
    assert.deepEqual(platform.permissions,['admin.manage']);
    const body={email:tag+'@tenant.invalid',role:'tenant_admin',modules:['quotes','orders'],max_sessions:2};
    const created=await service.createUser(platform,'create-user',body);
    const replay=await service.createUser(platform,'create-user',body);
    assert.equal(created.user.id,replay.user.id);
    assert.equal(replay.temporary_password,undefined);
    await assert.rejects(service.createUser(platform,'create-user',{...body,modules:[]}));
    const login={email:body.email,password:created.temporary_password};
    await assert.rejects(service.login({...login,password:'wrong-password'}));
    const first=await service.login(login);
    assert.equal(verifyAccess(first.access_token).tid,created.user.tenant_id);
    const sessions=await Promise.all([service.login(login),service.login(login)]);
    await assert.rejects(service.refresh(first.refresh));
    const fresh=new Db();
    try {
      const renewed=await new IdentityService(fresh).refresh(sessions[1].refresh);
      assert.equal(renewed.actor.sid,sessions[1].actor.sid);
    } finally {await fresh.onModuleDestroy();}
    const account=sessions[1].actor;
    const grant=await service.grantRead(account,'read-access',{admin_id:owner.id,permission:'quotes.read',minutes:10,
      reason:'support_ticket'});
    const ticket=await service.useGrant(platform,grant.id);
    assert.equal(ticket.actor.tid,account.tid);
    assert.deepEqual(ticket.actor.permissions,['quotes.read']);
    await service.revokeRead(account,'revoke-grant',grant.id);
    await assert.rejects(delegatedActor(db.client,platform,grant.id));
    const other=await service.createUser(platform,'other',{...body,email:tag+'@other.invalid'});
    const otherSession=await service.login({email:other.user.email,password:other.temporary_password});
    const otherActor=otherSession.actor;
    const id=randomUUID();
    await db.tenant(account,tx=>tx.$executeRaw`INSERT INTO pricing_rules(id,tenant_id,name,rule)
      VALUES(${id}::uuid,${account.tid}::uuid,'identity-boundary','{}'::jsonb)`);
    assert.equal((await db.tenant(otherActor,tx=>tx.$queryRaw<unknown[]>`SELECT id FROM pricing_rules WHERE id=${id}::uuid`)).length,0);
    assert.throws(()=>db.tenant(platform,async()=>{}));
    await assert.rejects(service.revoke(otherActor,'other-revoke',account.sid));
    await service.updateUser(platform,other.user.id,{version:1,valid_until:'2000-01-01T00:00:00Z'});
    await assert.rejects(service.refresh(otherSession.refresh));
    await assert.rejects(service.login({email:other.user.email,password:other.temporary_password}));
    await service.changeStatus(platform,'disable-user',account.uid,'disabled');
    await assert.rejects(loadActor(db.client,account.sid));
    await assert.rejects(service.login(login));
    await service.changeStatus(platform,'delete-user',account.uid,'deleted');
    assert.equal((await db.client.user.findUniqueOrThrow({where:{id:account.uid}})).status,'deleted');
  });
