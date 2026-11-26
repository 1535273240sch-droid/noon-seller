# 商渡 · Noon 外贸卖家工作台

适用于 Chrome / Edge 的 Manifest V3 扩展，配套 NestJS API、PostgreSQL 16、Redis / BullMQ 和 S3 兼容对象存储。工作台使用中文界面。当前可运行租户账号、手工汇率报价和本地商品图处理。订单和推荐提供标记清楚的开发数据，正式接入条件见[规格审查与验收记录](docs/review.md)。

## 本地启动

1. 安装 Node.js 22.12+（CI 使用 24）和 Docker Compose v2。按 [Compose 启动说明](infra/docker/README.md) 配置本地密钥，启动开发服务并创建首个平台管理员。
2. 在仓库根目录运行以下命令构建扩展。构建默认只授予 `http://localhost:3100` 接口访问权限。

   ```sh
   npm ci
   npm run build -w @noon/extension
   ```

3. 在 `chrome://extensions` 或 `edge://extensions` 开启开发人员模式，选择“加载已解压的扩展”，指向 `apps/extension/.output/chrome-mv3`。点击“商渡”弹窗的“打开工作台”。
4. 用平台管理员登录，在“账号管理”里创建租户管理员并勾选所需模块。妥善保存一次展示的临时密码，退出后用租户账号登录。平台账号默认只显示账号管理及汇总。
5. 试算报价时填写 SKU，默认示例参数为采购 50 CNY、首重运费 10 CNY、手工汇率 0.50 CNY→AED。计算后可核对 46.15 AED 的售价，保存报价再导出 Excel。取数时间应填写实际汇率时间。

本地开发要在订单页显示“导入模拟订单”，构建前设置 `WXT_DEMO_UI=true`。服务端仍校验环境与模块权限。无真实店铺后台 URL 时，扩展通过独立页进入工作台。

## 环境与验证

| 用途 | 命令或设置 |
| --- | --- |
| 安装与生成 Prisma 客户端 | `npm ci`、`npm run db:generate` |
| 应用迁移 | 设置迁移用 `DATABASE_URL` 后运行 `npm run db:migrate` |
| 构建后端与扩展 | `npm run build`、`npm run check:extension` |
| 创建首个平台管理员 | 设置 `BOOTSTRAP_EMAIL` 和 `BOOTSTRAP_PASSWORD`，执行 `npm run bootstrap -w @noon/api` |
| 启动 API | 设置 `APP_ENV`、`PORT=3100`、运行角色 `DATABASE_URL`、`JWT_SECRET`、`CORS_ORIGINS` 等后执行 `npm run start:api` |
| 数据库测试 | 为单独的已迁移测试库设置 `DATABASE_URL` 和 `TEST_DATABASE_URL`，执行 `npm test` |
| HTTP 冒烟 | 在临时开发库创建平台管理员，启动 API，执行 `node scripts/smoke.mjs`。设置 `SMOKE_S3=1` 同时验证实际对象上传和签名下载 |
| 本地模拟压测 | 同一临时开发环境执行 `node scripts/benchmark.mjs`，输出 1,000 行、每批 50 行和 50 个独立用户并发读取的结果 |
| 扩展打包 | `npm run package:extension`，产物在 `apps/extension/.output/` |
| 更换 API 地址 | 构建时设置 `WXT_API_ORIGIN=https://你的接口域名`，按扩展源设置服务端 CORS 白名单 |

开发扩展的固定来源为 `chrome-extension://gpbnbffcfojemjdadmldmepmaielcbdm`。JWT 仅在工作台内存中使用，刷新凭证由服务端设置 HttpOnly Cookie。生产 API 使用 HTTPS，各环境应使用独立数据库、桶、令牌签名密钥和连接加密主密钥。运行用数据库角色须为 NOSUPERUSER / NOBYPASSRLS。设置功能只向服务器传递外部凭证。

## 工程入口

| 位置 | 内容 |
| --- | --- |
| `apps/extension` | WXT、React、弹窗及业务页面 |
| `apps/api/src/identity` 与 `core.ts` | 账号、会话、临时授权、租户事务与审计 |
| `apps/api/src/commerce` | Decimal 计价、XLSX 导出、订单收发箱和同步任务 |
| `apps/api/src/catalog` | 上传、Sharp、额度账本、推荐与订阅 |
| `infra/prisma` | Prisma 身份模型与 PostgreSQL 迁移，包括业务表约束和 RLS |
| `infra/docker`、`.github/workflows` | 本地环境、备份恢复和持续验证 |

[查看持续集成](https://github.com/1535273240sch-droid/noon-seller/actions)
