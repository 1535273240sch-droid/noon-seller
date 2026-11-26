import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { apiError } from "../core";

function masterKey(): Buffer {
  const value = process.env.CREDENTIALS_MASTER_KEY ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw apiError(503, "KEY_UNAVAILABLE", "凭证主密钥尚未配置");
  return key;
}
function seal(key: Buffer, data: Buffer, context: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const content = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), content]);
}
function open(key: Buffer, data: Buffer, context: string) {
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
}
export function storeCredentials(value: unknown, context: string): Buffer {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).length ||
    Object.keys(value).length > 32 ||
    !Object.values(value).every((v) => typeof v === "string" && v.length > 0) ||
    Buffer.byteLength(JSON.stringify(value)) > 32768
  )
    throw apiError(400, "VALIDATION", "凭证应为最多 32 KB 的非空键值对象");
  const dek = randomBytes(32);
  try {
    return Buffer.concat([
      Buffer.from([1]),
      seal(masterKey(), dek, context + "/key"),
      seal(dek, Buffer.from(JSON.stringify(value)), context + "/value"),
    ]);
  } finally {
    dek.fill(0);
  }
}
export function readCredentials(
  envelope: Uint8Array,
  context: string,
): Record<string, string> {
  const data = Buffer.from(envelope);
  if (data[0] !== 1 || data.length <= 89)
    throw new Error("Unsupported credential envelope");
  const dek = open(masterKey(), data.subarray(1, 61), context + "/key");
  try {
    return JSON.parse(
      open(dek, data.subarray(61), context + "/value").toString(),
    );
  } finally {
    dek.fill(0);
  }
}
