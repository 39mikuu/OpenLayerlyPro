# 交接：规模化 A — 列表分页(消除首页/列表全量加载)

> 给执行 agent 的自包含实现说明。**前置依赖:当前 main 即可**。与自动支付**完全独立、可并行**(本任务改 content 列表 + 站点页 + 主题 PostList;不碰 payment)。
>
> 开工前建 issue(如「perf(content): keyset pagination for public post lists」),PR 关联。

## 0. 必读 / 现状

- `src/modules/content/index.ts` 的 **`listPosts({ publishedOnly, categorySlug, tagSlug }): Post[]`** —— **不带 limit,一次返回全部 post**。文章一多,首页与 `/posts` 全量加载 → 卡。
- 调用点:
  - `src/app/(site)/page.tsx`(首页,`listPosts({ publishedOnly:true })`)
  - `src/app/(site)/posts/page.tsx`(作品列表,带 category/tag 过滤)
  - `src/app/admin/(dashboard)/posts/page.tsx`(后台,全状态)
- 主题契约 `src/modules/theme/types.ts`:`PostListView = { posts: PostCardView[] }`;`localizePostCards` 做列表本地化。
- 现有索引 `posts_status_published_idx(status, published_at desc)` —— 正好支撑公开列表的 keyset 分页。

**范围**:公开列表(`/posts`)+ 首页的分页/限量。**后台列表分页可选**(见 §7,建议同做但用 `created_at` keyset)。

## 1. 已锁定决策(动工前若有异议先提)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **keyset(游标)分页,不用 offset**。公开列表按 `(published_at desc, id desc)` 排序,游标 = 不透明 base64(`publishedAt|id`)。 | offset 深翻页慢 + 插入时错位/重复;keyset 稳定且走现有索引 |
| D2 | **SSR 游标链接分页**(`/posts?cursor=...`),服务端渲染下一页链接。**不引入客户端列表状态/新前端框架**。 | 契合本项目 SSR-first + 极简前端的主题架构;SEO 友好;最小改动。"加载更多"客户端追加列为可选增强(见 §6) |
| D3 | **首页只限量**(取最新 N,如 12),**不分页**——首页本就是「最新若干」入口,分页放 `/posts`。 | 直接消除首页全量加载,零额外 UI |
| D4 | 页大小常量 `POSTS_PAGE_SIZE = 12`(放 content 模块,便于调) | 单一可调来源 |

## 2. content 模块改造 `src/modules/content/index.ts`

新增**分页查询**(不改 `listPosts` 现有签名,避免动后台/内部调用):

```ts
export const POSTS_PAGE_SIZE = 12;

// ⚠️ 游标时间戳不要建模成 Date（drizzle 把 timestamptz 暴露为 JS Date，只到毫秒，会丢微秒）。
// 用 SQL 选出的「UTC 规范化字符串」或 epoch 微秒原值,原样回传比较——见下方「游标精度」。
export type PostCursor = { publishedAtRaw: string; id: string }; // publishedAtRaw = SQL 选出的全精度 UTC 值
export function encodeCursor(c: PostCursor): string;   // base64(`${publishedAtRaw}|${id}`)，不经 Date
export function decodeCursor(s: string): PostCursor | null; // 非法 → null（当作首页）

// 公开已发布列表的一页：keyset
listPublishedPostsPage(opts: {
  limit?: number;            // 默认 POSTS_PAGE_SIZE
  cursor?: string | null;    // 不透明游标；null = 第一页
  categorySlug?: string;
  tagSlug?: string;
}): Promise<{ posts: Post[]; nextCursor: string | null }>
```

实现要点:
- `where status='published'`(+ 沿用 §taxonomy 的 `exists` 过滤,**保留可见性逻辑不变**)。
- keyset 条件:无 cursor → 仅 `status='published'`;有 cursor(`pa,id`)→ `AND (published_at < pa OR (published_at = pa AND id < id))`。
- `order by published_at desc, id desc limit :limit + 1` —— **多取 1 条**判断是否有下一页:返回 `posts = rows.slice(0, limit)`,`nextCursor = rows.length > limit ? encodeCursor(最后一条) : null`。
- 注意 `published_at` 理论可空,但 `status='published'` 行恒有 `published_at`(ADR 0004 的 check 约束保证),keyset 安全。
- 首页:可直接用 `listPublishedPostsPage({ limit: 12 })` 取首屏,忽略 `nextCursor`;或加一个轻量 `listLatestPublished(limit)` 包装。

### ⚠️ 游标精度(keyset 正确性关键,别踩)

`timestamptz` 列在 DB 是**微秒精度**,而 `Date.toISOString()` 只到**毫秒**。若游标用毫秒、而列里有亚毫秒值,边界处 `published_at < :pa` 会**漏掉** `(:pa_ms, :pa_us]` 之间的行(既被 `<` 排除、又不等于 `:pa`)→ 翻页**丢数据**。

- 公开列表的 `published_at` 目前恰好是毫秒(经 JS `Date` 写入),**暂时安全但脆弱**;**后台用的 `created_at` 是 `defaultNow()` = 微秒**,直接 `toISOString()` 游标**会漏行**。
- 正确做法(任选其一,务必两侧一致):
  - **A(推荐)**:游标保留完整精度,且**强制 UTC**——SQL 端取 `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`(**注意 `AT TIME ZONE 'UTC'`:`to_char` 默认按会话 TimeZone 格式化,DB 时区非 UTC 时硬加 `Z` 会解析成错误时刻 → 仍漏/重**),或直接用 epoch 微秒 `(extract(epoch from col)*1e6)::bigint`;回比时以 `:cursorTs::timestamptz`(或 epoch 微秒)精确比较;**全程不经 JS `Date`**。
  - **B**:两侧统一 `date_trunc('milliseconds', col)` 排序/比较 + `id` 兜底(同毫秒多行靠 id 决胜)。
- 不管哪种,`id` 必须是最终决胜键(uuid 顺序无业务含义但作为稳定 tiebreak 足够)。

## 3. 站点页改造

### `/posts`(`src/app/(site)/posts/page.tsx`)
- 读 `searchParams.cursor`(+ 现有 category/tag)→ `listPublishedPostsPage({ cursor, categorySlug, tagSlug })`。
- `localizePostCards` 只本地化这一页。
- 把 `nextCursor` 传进主题 view-model;有则渲染「下一页/更多」链接 `?cursor=<nextCursor>&category=...&tag=...`(保留过滤参数)。

### 首页(`src/app/(site)/page.tsx`)
- 改成限量(最新 12),不再全量。

## 4. 主题契约 `src/modules/theme/types.ts` + 内置主题

- `PostListView` 增加 `nextHref?: string | null`(由**页面**算好的下一页链接;主题只渲染,不碰游标编码)。
- 内置主题 `PostList`:`posts` 渲染不变,末尾若 `nextHref` 存在则渲染「下一页/查看更多」链接(复用现有按钮/链接原语 + i18n 文案)。
- 保持「主题只展示、不含业务」:游标编码、查询都在 Core/页面,主题只拿到 `posts` + `nextHref`。

## 5. i18n

`{zh,en,ja}.ts` 补:「下一页 / 查看更多 / 没有更多了」等列表分页文案。

## 6. 可选增强(本切片可不做,注明即可)

「加载更多」客户端追加:一个 client 组件按 `nextCursor` 调 `GET /api/posts?cursor=&category=&tag=`(返回本地化卡片 + nextCursor)追加渲染。若不做,SSR 链接分页已满足需求;做的话别破坏 SSR 首屏与 SEO。

## 7. 后台列表(建议同做,范围内)

`admin/(dashboard)/posts/page.tsx` 也会随文章增多变慢。建议同样加分页,但**按 `created_at desc, id desc` keyset**(后台含 draft/scheduled,`published_at` 可空,不能用它排序)。可独立函数 `listPostsPage({ limit, cursor })`。若本切片不做,在 PR 注明留作后续。

## 8. 测试

- keyset 单测/集成(真实 PG):
  - 翻页**不重不漏**:插入 N 条,按页取完 = 全集且无重复。
  - 同 `published_at` 多条时用 `id` 兜底排序稳定。
  - **游标精度边界**:构造亚毫秒/微秒不同但同毫秒的两条记录(尤其后台 `created_at`),翻页**不得漏行**(直接验证 §「游标精度」的修法生效)。
  - 翻页期间插入新 post 不会导致旧游标重复/跳行(keyset 特性)。
  - `limit+1` 判定 `nextCursor`:最后一页 `nextCursor=null`。
  - 分页 + category/tag 过滤叠加正确;**可见性/published 过滤不被破坏**。
  - 非法 cursor → 当作第一页(不报错)。
- 首页限量:只返回最新 N。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

(无 schema 迁移——纯查询 + 页面 + 主题契约扩字段。)

## 10. PR

- base `main`,draft,标题 `perf(content): keyset pagination for public post lists`。
- 描述:无迁移;新增 `listPublishedPostsPage` + 游标;`/posts` SSR 游标分页;首页限量;主题 `PostListView.nextHref`;后台是否同做。
- 关联对应 issue。

## 11. 验收 checklist

- [ ] 公开列表 keyset 分页(走现有索引),翻页不重不漏
- [ ] 首页限量,不再全量加载
- [ ] 分页与 category/tag 过滤叠加正确,可见性逻辑不变
- [ ] 非法/缺失 cursor 安全回落第一页
- [ ] 主题只拿 `posts` + `nextHref`,不含游标/查询逻辑
- [ ] 无 schema 迁移
