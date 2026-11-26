import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imagePlan, inspectUpload, renderImage, filters, isQuiet, subscriptionInput } from '../src/catalog/rules';
import { sourceOrThrow } from '../src/catalog/recommendations.service';

const id='0355026c-1c6a-4548-86e3-1b49346b1cc4';
test('T-F4-01 本地原图校验和商品主图输出', async () => {
  const bytes=await sharp({create:{width:120,height:80,channels:4,background:'#0284c7'}}).png().toBuffer();
  const input={mime:'image/png',copyright_ack:true,file_base64:bytes.toString('base64')};
  const upload=await inspectUpload(input);
  assert.deepEqual(upload.bytes,bytes);
  const plan=imagePlan({source_id:id,pipeline:['resize']});
  const result=await renderImage([upload.bytes],plan);
  const meta=await sharp(result).metadata();
  assert.equal(meta.width,1200);
  assert.equal(meta.height,1200);
  assert.equal(meta.format,'jpeg');
  assert.equal(meta.space,'srgb');
  assert.equal(meta.density,72);
  await assert.rejects(inspectUpload({...input,copyright_ack:false}));
  await assert.rejects(inspectUpload({...input,mime:'image/jpeg'}));
  await assert.rejects(inspectUpload({...input,file_base64:'bm90LWltYWdl'}));
});
const unavailable = (error: any) => error?.getResponse?.().error.code === 'SOURCE_UNAVAILABLE';
test('T-F4-04 生产环境仅运行本地确定性处理',() => {
  const previous=process.env.APP_ENV;
  try {
    process.env.APP_ENV='prod';
    for (const step of ['generate','cutout']) assert.throws(() => imagePlan({source_id:id,pipeline:[step]}),unavailable);
    assert.equal(imagePlan({source_id:id,pipeline:['resize']}).simulated,false);
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV=previous; }
});
test('T-F5-01/02/03 模拟源不能进入 staging 或 prod，服务端复核价格条件',() => {
  const originalApp=process.env.APP_ENV, originalNode=process.env.NODE_ENV;
  try {
    process.env.APP_ENV='dev'; process.env.NODE_ENV='test';
    assert.deepEqual(sourceOrThrow(),{id:'development-fixtures',simulated:true,label:'模拟数据',acceptance_ready:false});
    for (const env of ['staging','prod']) { process.env.APP_ENV=env; assert.throws(sourceOrThrow,unavailable); }
    process.env.APP_ENV='dev'; process.env.NODE_ENV='production'; assert.throws(sourceOrThrow,unavailable);
    assert.throws(() => filters({min_price:100,max_price:20}));
    assert.deepEqual(filters({site:'AE',min_price:'0',max_price:25}),{site:'AE',min_price:0,max_price:25});
  } finally {
    if (originalApp===undefined) delete process.env.APP_ENV; else process.env.APP_ENV=originalApp;
    if (originalNode===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=originalNode;
  }
});
test('T-F5-04 免打扰按订阅者时区判断，覆盖跨午夜和结束边界',() => {
  const plan=subscriptionInput({tz:'Asia/Dubai',frequency:'daily',dnd_start:'22:00',dnd_end:'08:00'});
  assert.equal(isQuiet(new Date('2026-11-26T18:00:00Z'),plan.tz,plan.start,plan.end),true);
  assert.equal(isQuiet(new Date('2026-11-27T03:59:00Z'),plan.tz,plan.start,plan.end),true);
  assert.equal(isQuiet(new Date('2026-11-27T04:00:00Z'),plan.tz,plan.start,plan.end),false);
  assert.equal(isQuiet(new Date('2026-11-27T04:00:00Z'),plan.tz,null,null),false);
  assert.throws(() => subscriptionInput({tz:'Unknown/Location',frequency:'hourly'}));
});
