import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { Actor, Db, Tx, apiError } from '../core';
import { ObjectStore } from './objects';
import { imagePlan, initialQuota, inspectUpload, Plan, renderImage, uuid } from './rules';

type Source = {id:string; s3_key:string};
type Job = {id:string; source_id:string; status:string; options:Plan; version:number; output_key:string|null; error_code:string|null};
const missing = () => apiError(404,'NOT_FOUND','资源不可用');
function checked(id: string) { if (!uuid(id)) throw missing(); return id; }
async function original(tx: Tx,id: string) {
  const [s] = await tx.$queryRaw<Source[]>`SELECT id,s3_key FROM upload_objects WHERE id=${checked(id)}::uuid`;
  if (!s) throw missing();
  return s;
}
async function account(tx: Tx,tenant: string|null) {
  await tx.$executeRaw`INSERT INTO quota_accounts(tenant_id,balance) VALUES(${tenant}::uuid,${initialQuota()}) ON CONFLICT DO NOTHING`;
}
@Injectable()
export class Images {
  constructor(private db:Db, private store:ObjectStore) {}
  async upload(actor:Actor,key:string,body:any) {
    const {bytes,mime,hash} = await inspectUpload(body);
    const path = `${actor.tid}/sources/${hash}`;
    return this.db.write(actor,key,'uploads',{hash,mime,copyright_ack:true},async tx => {
      // A retry after a storage success and DB failure writes the same tenant-scoped content key.
      await this.store.put(path,bytes,mime);
      const [o] = await tx.$queryRaw<{id:string}[]>`INSERT INTO upload_objects(tenant_id,s3_key,sha256,bytes,mime)
        VALUES(${actor.tid}::uuid,${path},${hash},${bytes.length},${mime})
        ON CONFLICT(tenant_id,sha256) DO UPDATE SET mime=EXCLUDED.mime RETURNING id`;
      return {id:o.id,source_id:o.id,mime,bytes:bytes.length};
    });
  }
  quota(actor:Actor) {
    return this.db.tenant(actor,async tx => {
      await account(tx,actor.tid);
      const [q] = await tx.$queryRaw<{balance:number}[]>`SELECT balance FROM quota_accounts WHERE tenant_id=${actor.tid}::uuid`;
      return q;
    });
  }
  async create(actor:Actor,key:string,body:any) {
    const plan = imagePlan(body);
    return this.db.write(actor,key,'image-jobs',body,async tx => {
      for (const id of [body.source_id,...plan.extra]) await original(tx,id);
      await account(tx,actor.tid);
      const [q] = await tx.$queryRaw<{balance:number}[]>`UPDATE quota_accounts SET balance=balance-1
        WHERE tenant_id=${actor.tid}::uuid AND balance>=1 RETURNING balance`;
      if (!q) throw apiError(409,'INSUFFICIENT_QUOTA','可用额度不足');
      const [job] = await tx.$queryRaw<{id:string}[]>`INSERT INTO image_jobs(tenant_id,source_id,pipeline,options)
        VALUES(${actor.tid}::uuid,${body.source_id}::uuid,${JSON.stringify(plan.pipeline)}::jsonb,${JSON.stringify(plan)}::jsonb) RETURNING id`;
      await tx.$executeRaw`INSERT INTO quota_ledger(tenant_id,job_id,entry_type,qty)
        VALUES(${actor.tid}::uuid,${job.id}::uuid,'reserve',1)`;
      return {job_id:job.id,status:'queued',simulated:plan.simulated,quota:{reserved:1,balance_after_reserve:q.balance}};
    });
  }
  async show(actor:Actor,id:string) {
    return this.db.tenant(actor,async tx => {
      const [job] = await tx.$queryRaw<any[]>`SELECT id,status,version,error_code,created_at,options->'simulated' AS simulated
        FROM image_jobs WHERE id=${checked(id)}::uuid`;
      if (!job) throw missing();
      const entries = await tx.$queryRaw<any[]>`SELECT entry_type,qty,created_at FROM quota_ledger WHERE job_id=${id}::uuid ORDER BY created_at,id`;
      return {job,quota_ledger:entries};
    });
  }
  async review(actor:Actor,id:string,key:string,body:any,approve:boolean) {
    checked(id);
    return this.db.write(actor,key,`image-jobs/${id}/${approve?'confirm':'discard'}`,body,async tx => {
      const [job] = await tx.$queryRaw<Job[]>`SELECT * FROM image_jobs WHERE id=${id}::uuid FOR UPDATE`;
      if (!job) throw missing();
      if (job.version !== body?.version) throw apiError(409,'VERSION_CONFLICT','素材状态已更新，请刷新');
      if (job.status !== 'succeeded_pending_review' || !job.output_key) throw apiError(409,'INVALID_STATE','仅已完成的待审核图片可操作');
      const status = approve ? 'confirmed' : 'discarded';
      await tx.$executeRaw`UPDATE image_jobs SET status=${status},version=version+1 WHERE id=${id}::uuid`;
      let asset_id: string|null = null;
      if (approve) {
        const [asset] = await tx.$queryRaw<{id:string}[]>`INSERT INTO assets(tenant_id,job_id,object_key,kind,simulated,reviewed_by)
          VALUES(${actor.tid}::uuid,${id}::uuid,${job.output_key},${job.options.kind},${job.options.simulated},${actor.uid}::uuid) RETURNING id`;
        asset_id = asset.id;
      }
      return {job_id:id,status,version:job.version+1,asset_id};
    });
  }
  async preview(actor:Actor,id:string) {
    const path = await this.db.tenant(actor,async tx => {
      const [job] = await tx.$queryRaw<Job[]>`SELECT status,output_key FROM image_jobs WHERE id=${checked(id)}::uuid`;
      if (!job?.output_key || !['succeeded_pending_review','confirmed'].includes(job.status)) throw missing();
      return job.output_key;
    });
    return this.store.link(path);
  }
  list(actor:Actor) {
    return this.db.tenant(actor,async tx => ({data:await tx.$queryRaw<any[]>`SELECT id,job_id,kind,simulated,approved_at
      FROM assets ORDER BY approved_at DESC,id LIMIT 100`}));
  }
  private async asset(tx:Tx,id:string) {
    const [a] = await tx.$queryRaw<{object_key:string}[]>`SELECT object_key FROM assets WHERE id=${checked(id)}::uuid`;
    if (!a) throw apiError(403,'FORBIDDEN','素材不可下载');
    return a.object_key;
  }
  async download(actor:Actor,id:string) {
    const path = await this.db.tenant(actor,tx => this.asset(tx,id));
    return this.store.link(path,`${id}.jpg`);
  }
  async bundle(actor:Actor,ids:unknown) {
    if (!Array.isArray(ids) || !ids.length || ids.length>10 || !ids.every(uuid) || new Set(ids).size !== ids.length)
      throw apiError(400,'VALIDATION','每份压缩包可选 1 至 10 张图片');
    const paths = await this.db.tenant(actor,async tx => {
      const out: string[] = [];
      for (const id of ids) out.push(await this.asset(tx,id));
      return out;
    });
    const files: Record<string,Uint8Array> = {};
    for (const [index,path] of paths.entries()) files[`${ids[index]}.jpg`] = await this.store.get(path);
    return Buffer.from(zipSync(files,{level:0}));
  }

  async processOne(actor:Actor) {
    const lease = randomUUID();
    const candidate = await this.db.tenant(actor, async tx => {
      const [job] = await tx.$queryRaw<(Job & {attempts:number})[]>`UPDATE image_jobs SET status='processing',version=version+1,
        lease_token=${lease}::uuid,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=(
        SELECT id FROM image_jobs WHERE (status='queued' AND next_attempt_at<=now()) OR
        (status='processing' AND lease_until<=now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      if (!job) return null;
      const paths:string[] = [];
      for (const id of [job.source_id,...job.options.extra]) paths.push((await original(tx,id)).s3_key);
      return {job,paths};
    });
    if (!candidate) return;
    const {job,paths} = candidate;
    const outputKey = `${actor.tid}/renders/${job.id}.jpg`;
    let success = false;
    try {
      const inputs:Buffer[] = [];
      for (const path of paths) inputs.push(await this.store.get(path));
      await this.store.put(outputKey,await renderImage(inputs,job.options),'image/jpeg');
      success = true;
    } catch {
      // Only the deterministic local renderer is registered. Paid-provider ambiguities must go to reconciliation.
    }
    await this.db.tenant(actor,async tx => {
      const [owned] = await tx.$queryRaw<{id:string}[]>`SELECT id FROM image_jobs WHERE id=${job.id}::uuid
        AND lease_token=${lease}::uuid AND status='processing' FOR UPDATE`;
      if (!owned) return;
      if (!success && job.attempts < 3) {
        await tx.$executeRaw`UPDATE image_jobs SET status='queued',lease_token=NULL,lease_until=NULL,
          next_attempt_at=now()+interval '30 seconds',version=version+1 WHERE id=${job.id}::uuid`;
        return;
      }
      const status = success ? 'succeeded_pending_review' : 'failed';
      await tx.$executeRaw`INSERT INTO quota_ledger(tenant_id,job_id,entry_type,qty)
        VALUES(${actor.tid}::uuid,${job.id}::uuid,${success?'consume':'release'},1)`;
      if (!success) await tx.$executeRaw`UPDATE quota_accounts SET balance=balance+1 WHERE tenant_id=${actor.tid}::uuid`;
      await tx.$executeRaw`UPDATE image_jobs SET status=${status},error_code=${success?null:'IMAGE_PROCESS_FAILED'},
        output_key=${success?outputKey:null},lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${job.id}::uuid`;
    });
  }
}
