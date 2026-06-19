# 交接：#11 备份 / 恢复 / 升级工具与流程

> 给执行 agent 的自包含实现说明。**前置依赖:#4–#10 已合并**(当前 main 即可)。
>
> 本任务以 **ops 脚本 + 文档 + 真实验证**为主,**无 schema / 无应用代码改动**。

## 0. 必读

- GitHub issue #11
- 现有文档(本任务是**补齐 + 脚本化 + 验证**,不是重写):
  - `docs/deployment/backup-restore.md`(已有基础步骤)
  - `docs/deployment/upgrade.md`
  - `docs/deployment/production-checklist.md`
- 现有部署事实:
  - `docker-compose.yml`:服务 `app` / `postgres`;卷 `postgres_data`、`uploads`、`secrets`。
  - `docker/entrypoint.sh`:启动时**自动跑迁移**(失败即退出);未提供 `CONFIG_ENCRYPTION_KEY` 时首次启动在 `/app/secrets/config-encryption-key` 生成密钥(权限 600)。
  - `src/modules/security/config-key.ts`:密钥来源 = env `CONFIG_ENCRYPTION_KEY` 优先,否则读 `CONFIG_ENCRYPTION_KEY_FILE`。
  - 健康检查:`GET /api/health`(存活)、`GET /api/ready`(DB+配置+密钥就绪)。
  - `scripts/migrate.mjs`(范式)、`scripts/admin-reset.mjs`(#8 新增的脚本范式)。

**范围**:备份/恢复脚本、当前版本线升级流程、**在干净环境跑一次完整恢复演练并记录结果**。
**不含**:历史旧版本升级测试(#3 已 deferred)、多实例/HA、自动定时备份编排(仅给手动脚本 + cron 示例)。

## 1. 三个必备份对象(缺一不可)

| 对象 | 位置 | 备注 |
|---|---|---|
| PostgreSQL 数据库 | `postgres` 服务 / `postgres_data` 卷 | `pg_dump` |
| 本地上传文件 | `uploads` 卷(仅 `STORAGE_DRIVER=local`) | S3/R2 时不在卷里,见 D4 |
| 配置加密根密钥 | `/app/secrets/config-encryption-key`(`secrets` 卷) | **丢失则后台加密配置不可恢复**;务必与 DB 同备份 |

## 2. 已锁定的设计决策(动工前若有异议先提)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **提供脚本** `scripts/backup.sh` + `scripts/restore.sh`(POSIX sh,基于 `docker compose`),产出/读取单个带时间戳的归档,**同时**含 DB dump + uploads + 密钥。 | issue 标题即「tooling」;一条命令覆盖三件套,避免漏备密钥。 |
| D2 | **验证 = 在干净环境跑一次恢复演练**:用独立 compose project(`-p ams_restore_test`)起全新栈 → 恢复归档 → `/api/ready` 200 → 抽样校验(如已发布文章数、某会员)。把演练步骤与**实际结果**写进 `backup-restore.md`。 | #3 完成标准:「Operational maintenance steps have been executed in a clean environment」。 |
| D3 | **升级仅覆盖当前版本线**:`git pull`/拉新镜像 → `docker compose up -d --build` → entrypoint 自动迁移 → 查 `/api/ready`。**升级前先 `backup.sh`**;迁移前向不可逆,**回滚 = 用升级前归档 `restore.sh`**。 | 迁移是 forward-only;历史版本升级已 deferred。 |
| D4 | **S3/R2 模式**:`backup.sh` 检测 `STORAGE_DRIVER`,`s3` 时跳过 uploads 卷并提示「对象存储由 bucket 版本化/provider 备份」;DB + 密钥仍备。 | local 与 S3 两条路径都要说清。 |
| D5 | 脚本**不打印密钥/密码内容**;失败有非零退出码;`restore.sh` 在恢复前要求确认(或 `--yes`)避免误覆盖。 | 安全 + 防误操作。 |

> 结论:**无 schema 迁移、无应用代码改动**;新增 2 个 shell 脚本 + 文档更新。

## 3. `scripts/backup.sh`(新建)

要点(POSIX sh):

```sh
# 用法: ./scripts/backup.sh [输出目录，默认 ./backups]
# 1) TS=$(date +%Y%m%d-%H%M%S); WORK=$(mktemp -d)
# 2) DB:  docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$WORK/db.sql"
#         （用户/库名从 .env 或默认 artist/artist_member 读取）
# 3) 密钥: docker compose exec -T app cat /app/secrets/config-encryption-key > "$WORK/config-encryption-key"  （chmod 600）
# 4) uploads: 若 STORAGE_DRIVER != s3:
#         docker compose cp app:/app/uploads "$WORK/uploads"   （或用 tar 流）
#    否则写一个 UPLOADS_SKIPPED_S3 标记文件
# 5) 打包: tar czf "$OUT/openlayerly-backup-$TS.tar.gz" -C "$WORK" .
# 6) 清理 WORK；打印归档路径与包含项（不打印密钥内容）
```

## 4. `scripts/restore.sh`(新建)

```sh
# 用法: ./scripts/restore.sh <archive.tar.gz> [--yes]
# 0) 解包到临时目录；无 --yes 时要求输入确认（会覆盖数据库与卷）
# 1) 建议先停 app： docker compose stop app
# 2) DB:  cat db.sql | docker compose exec -T postgres psql -U "$USER" -d "$DB"
#         （恢复到干净库；必要时先 drop/create，文档说明）
# 3) 密钥: docker compose cp config-encryption-key app:/app/secrets/config-encryption-key  （再 chmod 600 / chown）
# 4) uploads: 存在则 docker compose cp uploads/. app:/app/uploads
# 5) docker compose up -d app
# 6) 轮询 GET /api/ready 直到 200（或超时报错）
```

> 注意 entrypoint 会在 app 启动时自动迁移;恢复的是**同版本或更新版本**的库时迁移应是 no-op 或前向。跨大版本恢复不在范围。

## 5. 文档更新

- `docs/deployment/backup-restore.md`:用脚本替换/补充手抄命令;加 **D2 的干净环境恢复演练章节 + 实际执行结果**(命令、`/api/ready` 输出、抽样校验结论)。
- `docs/deployment/upgrade.md`:写明「先备份 → up --build → entrypoint 迁移 → /api/ready → 失败则 restore 回滚」;S3 与 local 差异。
- `docs/deployment/production-checklist.md`:加「定期备份 + 已验证恢复」勾项;给 cron 示例(`backup.sh` 每日)。
- `README` 安全/备份段落:链接脚本与密钥同备份警告(已有警告,补脚本指引)。

## 6. 验证(本任务的核心交付,必须真实执行)

在开发机用 Docker 实跑一遍并把结果写进文档:

1. `docker compose up -d`,完成 `/admin/setup`,造少量数据(1 会员 + 1 已发布文章 + 1 后台加密配置如 SMTP)。
2. `./scripts/backup.sh` → 得到归档。
3. **干净环境**:`docker compose -p ams_restore_test ... up -d`(全新卷)→ `./scripts/restore.sh`(指向该 project)→ `/api/ready` 200。
4. 校验:文章/会员数据在;**后台加密配置可读**(证明密钥恢复正确——这是最易被忽略的一环)。
5. 清理:`docker compose -p ams_restore_test down -v`。
6. 把上述命令与结果记入 `backup-restore.md`「Verified restore drill」小节。

## 7. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit && pnpm test && pnpm build
# shell 脚本：建议 shellcheck scripts/*.sh（本地）；确保可执行位 chmod +x
```

(脚本不影响应用构建;CI 仍应全绿。)

## 8. PR

- base `main`,draft,标题 `chore(ops): add backup/restore scripts and verified maintenance docs`。
- 描述声明:无 schema/无应用代码;新增 backup/restore 脚本;**附上干净环境恢复演练的真实输出**;local 与 S3 两条路径。
- 关联 `Closes #11`。

## 9. 验收 checklist(对应 issue #11)

- [ ] DB / uploads / 加密密钥三者均有备份手段(单命令覆盖)
- [ ] 提供 restore 脚本,且带覆盖确认
- [ ] 当前版本线升级流程 + 回滚(用备份)文档化
- [ ] local 与 S3 两种存储路径都说明
- [ ] **已在干净环境实跑恢复演练并记录结果**(含加密配置可读验证)
- [ ] 脚本不泄露密钥内容、失败非零退出
