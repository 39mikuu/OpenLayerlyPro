# v1.0.0 最终验收与发布清单

> 本文档是当前发布门槛的验收矩阵，原对应 issue #88（已关闭）。当前由 issue #104 负责把审计修复后的最终候选与既有验收证据重新绑定。#93 是旧候选的历史记录；不能把它直接当作最终候选证明，但也不得把后来已经完成的真实环境验收误写成“未执行”。旧的 `release-v0.2-checklist.md` 已被本清单取代，仅保留为历史说明。

代码合并、CI 通过或 handoff 文档完成均不等于可以发布。真实环境检查已经完成的项目必须保留其证据，不应无条件重跑；最终发布仍要求证据归档、最终 SHA 绑定、受后续改动影响范围的复验和维护者授权。

## 0. 当前执行快照（2026-07-03）

操作者确认以下真实环境门禁已经完成：

- [x] Stripe Test Mode：一次性 Checkout、订阅生命周期、退款/拒付、reversal 与 reconcile。
- [x] 真实 SMTP：成功、临时/永久失败、defer/dead/retry 与 delivery ledger。
- [x] 真实 S3/R2：上传、Range、signed redirect、删除、备份与恢复链路。
- [x] Turnstile 与生产式 CSP：report-only 观察后切换 enforce。
- [x] `SESSION_SECRET`、`CONFIG_ENCRYPTION_KEY` 与恢复点托管/丢失语义。
- [x] local 与真实 S3/R2 恢复验收。PR #120 还记录了真实 Docker 主机上 `d720719f06b3520a09eb2cfa57e2119f01f96d0a` 的 local/custom-secret、checksum、S3 和 legacy-secret 四套恢复演练通过。

这些项目现在的状态是“**已执行，待正式报告同步**”，不是“未执行”。#104 剩余：

- [ ] 为上述门禁补齐日期、环境标识、测试 SHA、结果摘要与证据链接，写入最终候选报告。
- [ ] 决定 Draft PR #122/#123 的版本归属；任何合并都会改变最终候选 SHA。
- [ ] 冻结最终 `main` SHA 与不可变构建产物。
- [ ] 对冻结 SHA 执行 exact-final-SHA CI，并只复验后续改动实际影响的门禁。
- [ ] 确认 AI translation provider smoke 与 GitHub Dependabot/CodeQL/Secret Scanning 可见性记录。
- [ ] 由维护者审阅报告并授权 tag / GitHub Release。

## 1. 前置条件

- [x] #86 S6 nonce-based security response headers 已合并并完成浏览器验证。
- [x] #87 S7 backup/restore consistency 已合并并完成 local 与 S3/R2 隔离恢复演练。
- [x] #119/#120 持久化自动 `SESSION_SECRET` 已合并，并完成真实 Docker 恢复演练。
- [ ] 从最终冻结的 `main` 和不可变构建产物执行最后一轮受影响范围验收，不使用功能分支。
- [ ] 发布候选提交 SHA、镜像摘要、数据库 migration journal 与验收环境已记录。

## 2. 安全与认证

- [ ] S1a Stored XSS 回归：伪造 MIME、SVG/HTML/polyglot、多帧/超像素图片均被拒绝、重编码或 quarantine。
- [ ] `payment_proof` 保持 attachment 响应、严格 CSP/sandbox 与 `nosniff`，不得作为同源可执行内容渲染。
- [ ] S2 所有生产 Route Handler 通过 `check:request-bodies`；声明超限、无 `Content-Length` 和低报长度均按实际字节有界处理。
- [ ] Stripe webhook 在验签前按原始字节有界读取，超限返回稳定 413。
- [ ] S4 admin-login、request-code、verify-code 的 resolved/unresolved 身份与阈值符合部署配置。
- [ ] 正确登录码不受 wrong-attempt 桶阻断；错误码只在核心比较失败后记账。
- [ ] source-scoped pre-comparison hard budget 能限制昂贵比较，同时另一可信 IP 仍可正常登录。
- [x] S6 已在真实环境完成 `report-only` 观察并切换 `enforce`。
- [x] 生产 CSP 不含 `script-src 'unsafe-inline'` 或 `'unsafe-eval'`；同一请求的框架脚本、应用脚本和响应头 nonce 一致，跨请求不同。
- [x] DB 启用 Turnstile、真实 S3/R2 signed redirect、内联视频和公开 integration 均在强制 CSP 下正常工作。
- [ ] legacy custom footer 代码已迁移、显式禁用或保持在安全 rollout 状态，不得静默失效。

## 3. 支付、会员与邮件

- [ ] 人工付款：创建、proof 上传/重提、审核通过、驳回、取消和凭证生命周期正常。
- [x] Stripe 一次性 Checkout：创建、success redirect 不直接授予、签名 webhook 授予、过期 session 清理正常。
- [x] Stripe 自动订阅：Checkout、首期、续费 invoice、取消、乱序事件、invoice 幂等和 reconcile 正常。
- [ ] 手动周期提醒：周期推进、用户控制、取消/stale no-op 和 zh/en/ja 邮件正常。
- [x] 全额退款、拒付、charge→invoice 解析、reversal-first 墓碑和重复 webhook 正常；部分退款按既定策略处理。
- [ ] 同用户并发 grant、人工/自动 pending 冲突、升级和顺排不会丢失已付时长。
- [x] SMTP 正常、临时失败、永久失败、未配置/需运维介入、最长等待超时与后台重发均符合 S5。
- [x] 稳定 Message-ID 与 delivery ledger 可追踪投递；日志、admin task response、delivery ledger 和归一化 provider error 不暴露验证码、SMTP secret、原始 provider 错误或原始收件人地址。`tasks.payload_json.to` 当前仍保存收件人地址，数据库与备份必须按敏感用户数据保护。

## 4. 文件、内容与存储

- [ ] local 内容附件流式上传、`.part` 原子落盘、失败清理和实际字节上限正常。
- [x] 真实 S3/R2/MinIO multipart 上传、abort、补偿删除和 bucket 生命周期规则正常。
- [x] local/S3 单段 Range 的 200/206/416、`Content-Range`、`Accept-Ranges` 与鉴权顺序正常。
- [x] public S3 视频只在真实公开授权路径下获得 inline signed redirect；login/member 视频保持逐请求鉴权代理。
- [ ] 文件删除完整检查 `post_files`、封面、付款方式、site settings、所有付款凭证引用；两阶段对象删除可重试。
- [ ] payment proof cleanup/resubmit/配额不会造成悬空引用或删除仍被引用的文件。
- [ ] inline image / video 的 draft、published、archived translation 与匿名/登录/会员/admin 权限矩阵无回退。
- [ ] 定时发布、keyset 分页、Markdown、公开视频嵌入、主题、zh/en/ja 和 AI translation 完成 smoke test。

## 5. 部署、升级、备份与恢复

- [ ] 全新 Docker Compose 安装、迁移和 `/admin/setup` 正常。
- [ ] 首次初始化前，实例、Cloudflare Tunnel 与反向代理保持非公开；确认首次 setup 已完成（`initialized=true`）、`/admin/setup` 已关闭后再对公网暴露。setup 端点在初始化前对未认证访问者开放，第一个完成 setup 的调用者即成为管理员——并发不会造成部分初始化或重复管理员（见 `docs/audit/issue-103-concurrent-setup.md`），但公开暴露窗口仍须由运维在暴露前关闭。
- [ ] 从受支持旧版本升级时，先解决 pending-payment 冲突，再运行 migrator 与 mandatory file-safety backfill，最后启动 app。
- [x] archive v2 包含 manifest 与完整 SHA-256；任一 payload 被篡改时在破坏正式数据库前失败。
- [x] v1 legacy archive 的 migration prefix、更新、分叉、unknown 和显式 override 矩阵符合 fail-closed 规则。
- [x] v1 schema probe 的随机临时数据库在成功、失败和信号退出后均被清理；兼容检查前正式数据库未被 drop。
- [ ] 恢复旧于 S1a 的数据时，缺失对象先 quarantine，随后 mandatory file-safety backfill 能重编码安全 raster 并隔离旧 SVG/HTML/非 raster。
- [x] 恢复时全部 `storage.delete_object` task（包括 terminal 行）被中和，最终收敛只为真实孤儿重新入队。
- [x] 非终态 provider event 与 dispatch task 成对复位；缺 task、饱和 attempts 和窄窗口均可幂等恢复。
- [x] local 与真实 S3/R2：备份 → 人为制造 DB/对象/任务/支付漂移 → 独立 Compose 恢复 → `/api/ready` 200。
- [x] 恢复后抽样核对管理员、会员、付款、订阅、文章、翻译、加密配置、文件和任务状态。
- [x] `SESSION_SECRET` 与 `CONFIG_ENCRYPTION_KEY` 的外部备份、恢复和丢失语义已由操作者实际确认。

## 6. 工程质量

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm check:request-bodies`
- [ ] `pnpm exec tsc --noEmit`
- [ ] `RUN_DB_INTEGRATION_TESTS=true pnpm test`
- [ ] `pnpm build:migrator`，并确认 `dist/migrate.mjs` 可在目标 one-off 容器中启动。
- [ ] `pnpm build:files-backfill`，并确认 `dist/files-backfill.mjs` 可在目标 one-off 容器中启动。
- [ ] `pnpm build:admin-reset`，并确认 `dist/admin-reset.mjs` 可在目标发布镜像中执行受支持的恢复流程。
- [ ] CI 已独立构建并检查上述三个 one-off artifact；不能只依赖 `pnpm build`。
- [ ] `pnpm build`
- [ ] shellcheck、浏览器 E2E 和恢复 E2E 全绿。
- [ ] 没有未处理的 high/critical Dependabot、CodeQL 或其他发布阻塞安全告警。

## 7. 文档与发布动作

- [ ] README、PRD、roadmap、CHANGELOG、Security Policy、部署、升级和备份恢复文档与最终运行时一致。
- [ ] 写明从上一可用版本升级到 v1.0.0 的前置 remediation、破坏性变化、不可自动 down-migrate 的限制与恢复路径。
- [x] 核对 open issues；#101/#102/#103 已按证据关闭，当前仅 #104 保持 open。
- [ ] 把已完成真实环境验收的证据同步到最终候选报告。
- [ ] 发布候选环境完成最终冒烟后，冻结提交并创建 annotated `v1.0.0` tag。
- [ ] 使用本清单结果与 CHANGELOG 创建 GitHub Release。
- [ ] Release 发布后验证 tag、源码归档、镜像/构建说明和文档链接。
- [ ] 全部完成后关闭 #104；#64 已作为实现 epic 关闭，无需再次关闭。

## 不阻塞 v1.0 的后续项

- Plugin runtime、Hub official plugin 与多实例高可用。
- 视频封面、时长、缩略图、转码、HLS/DASH 与 multipart Range。
- 归档译文恢复/历史查看。#58 retention 缺口已由 PR #118 修复并关闭。