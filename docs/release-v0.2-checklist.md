# v0.2.0 最终验收清单

本清单用于 `v0.2.0` 发布前的最后人工验收。代码合并、CI 通过不等于发布完成；只有以下真实环境检查全部通过后，才创建 `v0.2.0` tag 和 GitHub Release。

## 1. 基线与升级

- [ ] 从最新 `main` 构建，而不是功能分支。
- [ ] `pnpm install --frozen-lockfile` 通过。
- [ ] `pnpm lint`、`pnpm format:check`、`pnpm exec tsc --noEmit` 通过。
- [ ] PostgreSQL 数据库迁移通过。
- [ ] 全量测试、migrator 构建和 Next.js 生产构建通过。
- [ ] 使用一份 v0.1.0 数据库和上传目录执行升级演练。
- [ ] 升级前备份包含数据库、local uploads 和配置加密密钥。
- [ ] 升级后原有管理员、会员、订单、文章和下载仍可正常访问。

## 2. Stripe Test Mode

- [ ] 后台保存 Stripe Test Mode 配置并通过连接测试。
- [ ] 创建一次性 Checkout Session 成功。
- [ ] success redirect 本身不会直接激活会员。
- [ ] 只有验签成功的 webhook 才批准付款并开通会员。
- [ ] 重放同一 webhook 不会重复开通会员或重复发送邮件任务。
- [ ] 金额或币种不匹配时事务回滚，不开通会员。
- [ ] `checkout.session.expired` 会取消仍处于 `pending_payment` 的申请。
- [ ] Stripe webhook 已订阅 `charge.refunded` 与 `charge.dispute.created`。
- [ ] 全额退款会将付款申请改为 `reversed`，并仅撤销该申请开通的会员。
- [ ] 拒付创建使用独立审计动作，并停用对应会员访问。
- [ ] reversal-first 场景会先持久化 `reversed`，后到的 paid webhook 不会开通会员。
- [ ] 部分退款与同一 Stripe 账户中其他产品的事件会安全忽略。
- [ ] 退款/拒付通知不包含 Stripe event ID、拒付详情或其他敏感 provider 数据。
- [ ] 新鲜 `creating:*` claim 返回 409，避免并发重复创建。
- [ ] 超过 2 分钟的 stale claim 能恢复，并复用原 payment request ID。
- [ ] Stripe 后台只出现一个由 `checkout:<requestId>` 幂等键保护的 Checkout Session。

## 3. Local 流式上传

- [ ] 上传大于常规图片大小的 ZIP 或视频时，应用内存没有随整文件大小线性增长。
- [ ] `mp4`、`webm`、`mov`、`m4v` 均能上传并生成正确文件记录。
- [ ] 上传完成后只有最终文件，没有遗留 `.part`。
- [ ] 中断上传后 `.part` 被删除。
- [ ] 超过配置上限时返回 413，且不保留临时或最终文件。
- [ ] 空 body 返回 `fileEmpty`，且不保留对象和数据库记录。
- [ ] 已上传附件仍经过原有权限检查后下载。
- [ ] 当前 local 下载不支持 Range/206；拖动视频进度属于 B2，不作为 v0.2 阻塞项。

## 4. S3 / R2 流式上传

- [ ] 使用真实 S3、R2 或兼容对象存储完成连接测试。
- [ ] 上传一个大于 8 MiB 的对象，确认 multipart 路径可用。
- [ ] 并发上传时应用内存保持有界。
- [ ] 客户端断开后 multipart 被 abort。
- [ ] 超限后 multipart 被 abort，最终对象不存在。
- [ ] 模拟数据库写入失败后，已上传对象被删除。
- [ ] bucket 已配置 abort-incomplete-multipart lifecycle 规则。
- [ ] 历史文件继续按文件记录中的 `storageDriver` 和 bucket 读取。

## 5. 分页与公开页面

- [ ] 首页只加载规定数量的最新文章。
- [ ] `/posts` 下一页使用 keyset cursor，不使用 offset。
- [ ] 分类、标签和可见性过滤在翻页后仍保持一致。
- [ ] 非法、截断或语义无效的 cursor 安全回退第一页，不产生 500。
- [ ] PostgreSQL 六位微秒时间戳排序没有重复或漏项。
- [ ] zh/en/ja 公开页面和新增错误文案显示正常。

## 6. 备份、恢复与回滚

- [ ] 发布前生成完整备份并记录文件位置和校验值。
- [ ] 在干净环境完成一次恢复演练。
- [ ] 确认配置加密密钥恢复后，SMTP、S3/R2、Turnstile 和 Stripe 密钥仍可解密。
- [ ] 写明回滚到 v0.1.0 的步骤；禁止在没有数据库备份时直接回滚应用。

## 7. 发布动作

全部项目通过后执行：

```bash
git checkout main
git pull --ff-only
git tag -a v0.2.0 -m "v0.2.0 — automatic payments and scale hardening"
git push origin v0.2.0
```

随后使用 `CHANGELOG.md` 的 `v0.2.0` 内容创建 GitHub Release。
