import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { apiError } from "../core";
import { maxUpload } from "./rules";

@Injectable()
export class ObjectStore implements OnModuleDestroy {
  private client?: S3Client;
  private signer?: S3Client;
  private storage(publicHost = false) {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw apiError(503, "STORAGE_UNAVAILABLE", "对象存储未配置");
    const options = {
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true,
      endpoint: process.env.S3_ENDPOINT || undefined,
    };
    const client = publicHost
      ? (this.signer ??= new S3Client({
          ...options,
          endpoint: process.env.S3_PUBLIC_ENDPOINT || options.endpoint,
        }))
      : (this.client ??= new S3Client(options));
    return { bucket, client };
  }
  async put(key: string, bytes: Buffer, mime: string) {
    const { bucket, client } = this.storage();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
      }),
    );
  }
  async get(key: string) {
    const { bucket, client } = this.storage();
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!object.Body || (object.ContentLength ?? Infinity) > maxUpload)
      throw new Error("Invalid source object");
    const bytes = await object.Body.transformToByteArray();
    if (bytes.length > maxUpload) throw new Error("Oversize object");
    return Buffer.from(bytes);
  }
  async link(key: string, filename?: string) {
    const { bucket, client } = this.storage(true);
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: filename
          ? `attachment; filename="${filename}"`
          : "inline",
      }),
      { expiresIn: 300 },
    );
    return { url, expires_in: 300 };
  }
  onModuleDestroy() {
    this.signer?.destroy();
    this.client?.destroy();
  }
}
