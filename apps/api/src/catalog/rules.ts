import { createHash } from "node:crypto";
import sharp from "sharp";
import { apiError } from "../core";

export const maxUpload = 10 * 1024 * 1024;
const sharpOptions = {
  limitInputPixels: 32_000_000,
  failOn: "warning" as const,
};
export const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function development() {
  return (
    (process.env.APP_ENV ?? "dev") === "dev" &&
    process.env.NODE_ENV !== "production"
  );
}

export function initialQuota() {
  const value = Number(
    process.env.IMAGE_INITIAL_QUOTA ?? (development() ? 20 : 0),
  );
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw new Error("Invalid IMAGE_INITIAL_QUOTA");
  return value;
}

export async function inspectUpload(body: any) {
  if (body?.copyright_ack !== true)
    throw apiError(400, "VALIDATION", "请先确认原图使用权");
  const encoded = body.file_base64;
  if (
    typeof encoded !== "string" ||
    !encoded.length ||
    encoded.length > 4 * Math.ceil(maxUpload / 3) ||
    encoded.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(encoded)
  )
    throw apiError(400, "VALIDATION", "请上传 10 MiB 以内的 JPEG 或 PNG");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maxUpload ||
    bytes.toString("base64") !== encoded
  )
    throw apiError(400, "VALIDATION", "无效的图片数据");
  try {
    const image = sharp(bytes, sharpOptions);
    const meta = await image.metadata();
    if (
      !["jpeg", "png"].includes(meta.format ?? "") ||
      body.mime !== `image/${meta.format}` ||
      (meta.pages ?? 1) > 1
    )
      throw new Error("format");
    await image.resize(1, 1).raw().toBuffer();
    return {
      bytes,
      mime: body.mime as string,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw apiError(400, "VALIDATION", "文件损坏、类型不符或超过解码像素上限");
  }
}

export type Plan = {
  pipeline: string[];
  label: string;
  extra: string[];
  kind: string;
  simulated: boolean;
};
export function imagePlan(body: any): Plan {
  if (!uuid(body?.source_id)) throw apiError(400, "VALIDATION", "请选择原图");
  const pipeline = body.pipeline ?? ["resize"];
  if (
    !Array.isArray(pipeline) ||
    !pipeline.length ||
    new Set(pipeline).size !== pipeline.length ||
    pipeline.some(
      (x) =>
        !["resize", "collage", "overlay", "cutout", "generate"].includes(x),
    )
  )
    throw apiError(400, "VALIDATION", "无效的处理步骤");
  const simulated = pipeline.some((x) => x === "cutout" || x === "generate");
  if (simulated && !development())
    throw apiError(503, "SOURCE_UNAVAILABLE", "外部图像服务尚未接入");
  const label = body.label ?? "";
  if (
    typeof label !== "string" ||
    label.length > 64 ||
    /[\x00-\x1f]/.test(label) ||
    (pipeline.includes("overlay") ? !label.trim() : label.length > 0)
  )
    throw apiError(400, "VALIDATION", "卖点文字需要 1 至 64 个字符");
  const extra = body.extra_source_ids ?? [];
  if (
    !Array.isArray(extra) ||
    extra.length > 3 ||
    extra.some((x) => !uuid(x)) ||
    extra.length > 0 !== pipeline.includes("collage")
  )
    throw apiError(400, "VALIDATION", "拼图需 1 至 3 张附加原图");
  const kind = pipeline.includes("collage")
    ? "collage"
    : pipeline.includes("overlay")
      ? "callout"
      : pipeline.includes("generate")
        ? "scene"
        : "white";
  return { pipeline, label, extra, kind, simulated };
}

function escapeSvg(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderImage(inputs: Buffer[], plan: Plan) {
  const background = plan.pipeline.includes("generate") ? "#e9e4dc" : "#ffffff";
  const size = 1200;
  const columns = inputs.length > 1 ? 2 : 1;
  const rows = Math.ceil(inputs.length / columns);
  const cellWidth = size / columns,
    cellHeight = size / rows;
  const layers: sharp.OverlayOptions[] = [];
  for (const [i, input] of inputs.entries()) {
    const tile = await sharp(input, sharpOptions)
      .rotate()
      .resize(cellWidth - 40, cellHeight - 40, { fit: "contain", background })
      .flatten({ background })
      .png()
      .toBuffer();
    layers.push({
      input: tile,
      left: (i % columns) * cellWidth + 20,
      top: Math.floor(i / columns) * cellHeight + 20,
    });
  }
  if (plan.label || plan.simulated) {
    const banner = `<svg width="1200" height="104"><rect width="1200" height="104" fill="#203b42"/><text x="36" y="66" font-family="sans-serif" font-size="34" fill="white">${plan.simulated ? "DEMO  " : ""}${escapeSvg(plan.label)}</text></svg>`;
    layers.push({ input: Buffer.from(banner), top: size - 104, left: 0 });
  }
  return sharp({
    create: { width: size, height: size, channels: 3, background },
  })
    .composite(layers)
    .toColourspace("srgb")
    .withMetadata({ density: 72 })
    .jpeg({ quality: 88 })
    .toBuffer();
}

export interface Filters {
  site?: string;
  category?: string;
  min_price?: number;
  max_price?: number;
}
export function filters(input: any): Filters {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw apiError(400, "VALIDATION", "无效的推荐筛选");
  const result: Filters = {};
  for (const key of ["site", "category"] as const) {
    if (input[key] === undefined || input[key] === "") continue;
    if (typeof input[key] !== "string" || input[key].length > 80)
      throw apiError(400, "VALIDATION", "无效的站点或类目");
    result[key] = input[key];
  }
  for (const key of ["min_price", "max_price"] as const) {
    if (input[key] === undefined || input[key] === "") continue;
    const value = Number(input[key]);
    if (
      !["string", "number"].includes(typeof input[key]) ||
      !Number.isFinite(value) ||
      value < 0
    )
      throw apiError(400, "VALIDATION", "价格须为非负数");
    result[key] = value;
  }
  if ((result.min_price ?? 0) > (result.max_price ?? Infinity))
    throw apiError(400, "VALIDATION", "价格区间无效");
  return result;
}
export function subscriptionInput(body: any) {
  const tz = body?.tz;
  try {
    if (typeof tz !== "string" || !tz) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw apiError(400, "VALIDATION", "请选择有效的 IANA 时区");
  }
  if (!["hourly", "daily"].includes(body.frequency))
    throw apiError(400, "VALIDATION", "频次须为 hourly 或 daily");
  const start = body.dnd_start || null,
    end = body.dnd_end || null;
  const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
  if (
    Boolean(start) !== Boolean(end) ||
    (start && (!clock.test(start) || !clock.test(end) || start === end))
  )
    throw apiError(400, "VALIDATION", "免打扰须提供两个不同的 HH:mm 时间");
  return {
    filters: filters(body.filters ?? {}),
    tz,
    frequency: body.frequency,
    start,
    end,
  };
}

export function isQuiet(
  date: Date,
  tz: string,
  start: string | null,
  end: string | null,
) {
  if (!start || !end) return false;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const from = start.slice(0, 5),
    to = end.slice(0, 5);
  return from < to ? clock >= from && clock < to : clock >= from || clock < to;
}
