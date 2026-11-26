# 本地开发环境

从仓库根目录进入 `infra/docker`。需要 Node.js 22.12+、支持 Linux 容器的 Docker 和 Compose v2。首次启动会构建 API 镜像，并在具名卷中初始化 PostgreSQL 16、Redis 7 和私有对象桶。

```powershell
cd infra/docker
node make-env.cjs dev
docker compose up -d --build
docker compose ps -a
docker compose run --rm bootstrap
Invoke-RestMethod http://localhost:3100/v1/health
```

生成器在当前目录创建 Git 忽略的 `.env`，每个密码独立随机生成。初始管理员邮箱和密码位于该文件，首次建号前可修改。`bootstrap` 只在首个管理员尚未创建时成功。先以管理员登录扩展并创建租户管理员，再以租户账号进入业务工作台。

API 默认地址为 `http://localhost:3100`，扩展允许的来源为 `chrome-extension://gpbnbffcfojemjdadmldmepmaielcbdm`。应用容器通过 `http://storage:9000` 访问私有桶，浏览器通过 `http://localhost:9100` 访问 5 分钟有效的签名链接。在仓库根目录执行 `npm ci` 和 `npm run build -w @noon/extension`，将 `apps/extension/.output/chrome-mv3` 作为已解压扩展加载。

## 数据库角色与环境

`noon_migrate` 拥有业务表，`migrate` 执行 `prisma migrate deploy`，接着 `grants` 为 `noon_app` 授予业务表的读写权限。API 使用受 RLS 约束的 `noon_app`，该账号无法修改表结构或迁移历史。数据库初始化参数只在空卷首次启动时生效。新建密码文件要与已有数据卷配套保管。

`APP_ENV` 可取 `dev`、`staging` 或 `prod`。在独立项目目录与具名卷运行不同环境，各自生成配置文件。开发模拟推荐、订单和出图仅在 `dev` 开放。此 Compose 的端口、回环地址与证书选项用于单机联调。`docker compose stop` 暂停容器，`docker compose up -d` 恢复服务。

## 备份与恢复演练

以下 PowerShell 命令在 `infra/docker` 目录执行。数据库备份和对象备份应落在同一时间窗口。本地演练可短暂停止 API。使用受保护的备份目录，另行保管该环境的密钥。

```powershell
$stamp = Get-Date -Format yyyyMMdd-HHmmss
$backupDir = Join-Path ([IO.Path]::GetTempPath()) "noon-backup-$stamp"
New-Item -ItemType Directory -Path $backupDir | Out-Null
docker compose stop api
try {
  docker compose exec -T db pg_dump -U postgres -d noon -Fc -f "/tmp/noon-$stamp.dump"
  if ($LASTEXITCODE) { throw "数据库备份失败" }
  docker compose cp "db:/tmp/noon-$stamp.dump" "$backupDir/noon.dump"
  if ($LASTEXITCODE) { throw "复制备份失败" }
  docker compose run --rm --no-deps -v "${backupDir}:/backup" --entrypoint /bin/sh storage-init -ec 'mc alias set src http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror src/noon-assets /backup/noon-assets'
  if ($LASTEXITCODE) { throw "对象备份失败" }
} finally {
  docker compose start api
}
```

在同一集群中新建演练库。以下步骤保留原库和原桶，并验证迁移历史可重放。若要在新集群恢复，请先运行本目录的数据库角色初始化，使用备份环境的角色名。

```powershell
$drill = "noon_drill_" + (Get-Date -Format yyyyMMddHHmmss)
docker compose exec -T db createdb -U postgres $drill
if ($LASTEXITCODE) { throw "演练库创建失败" }
docker compose cp "$backupDir/noon.dump" "db:/tmp/$drill.dump"
docker compose exec -T db pg_restore --exit-on-error -U postgres -d $drill "/tmp/$drill.dump"
if ($LASTEXITCODE) { throw "恢复失败" }
docker compose run --rm --no-deps -e "DRILL_DB=$drill" migrate sh -ec 'export DATABASE_URL="${DATABASE_URL%/noon}/$DRILL_DB"; npm run db:migrate'
if ($LASTEXITCODE) { throw "迁移检查失败" }
docker compose exec -T db psql -U postgres -d $drill -c 'SELECT count(*) FROM orders'
docker compose run --rm --no-deps -v "${backupDir}:/backup:ro" -e "DRILL_BUCKET=noon-drill-$stamp" --entrypoint /bin/sh storage-init -ec 'mc alias set dst http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb dst/$DRILL_BUCKET && mc mirror /backup/noon-assets dst/$DRILL_BUCKET && mc diff /backup/noon-assets dst/$DRILL_BUCKET'
```

恢复验收应对照备份时的租户数、订单数和对象数，抽样读取已审核图片，并测试受限账号的跨租户拒绝结果。Redis 负责任务调度，订单 outbox 与图片租约均在 PostgreSQL 中。按约定的恢复窗口定期演练，并将数据库与对象备份复制到独立位置。
