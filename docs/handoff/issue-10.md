# 交接：#10 标签与分类（taxonomy）

> 给执行 agent 的自包含实现说明。**前置依赖：#9 已合并**（发布工作流稳定）。
>
> 与发布态、付款、会员均无耦合；是相对独立的内容组织功能。

## 0. 必读

- GitHub issue #10
- 现有代码：
  - `src/db/schema/index.ts`（`posts` / `postTranslations` / 既有 join 表 `post_files` 的写法可参考）
  - `src/modules/content/index.ts`（`listPosts` / `getPublishedPostBySlug` / `getLocalizedPost`——taxonomy 过滤/展示在此接入）
  - `src/components/admin/post-editor.tsx`（文章编辑——加 分类/标签选择器）
  - `src/components/admin/tier-manager.tsx`、`payment-method-manager.tsx`（后台 CRUD 管理器范式，照抄风格）
  - `src/app/(site)/posts/page.tsx` 与 `[slug]/page.tsx`（前台列表/详情——展示与按 taxonomy 过滤）

**范围**：分类/标签的 schema + 后台管理 + 文章关联 + 前台展示（+ 可选按 taxonomy 过滤列表）。
**不含**：层级分类（嵌套树）、taxonomy 级别的访问控制、taxonomy 名称多语言（见 D2）。

## 1. 已锁定的设计决策（动工前若有异议先提）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **taxonomy 不是访问边界**。可见性仍只由 `posts.visibility`（public/login/member）+ `requiredTierId` 决定;分类/标签只用于组织与浏览。 | 避免出现两套权限规则;#10 issue 要求与发布态隔离,权限同理。 |
| D2 | **v1 名称单语言**(`name` + `slug`),不做 taxonomy 翻译表。 | 控制范围;slug 为稳定标识。多语言名称留作后续(可仿 `postTranslations` 加 `taxonomy_translations`)。**这是有意的 v1 限制,需在 PR/文档注明。** |
| D3 | **分类与标签都用「独立表 + 多对多 join 表」**:`categories`/`tags` + `post_categories`/`post_tags`。 | 结构统一、标准做法;单创作者站点一篇文章可属多个分类也无妨。 |
| D4 | **删除 taxonomy 仅级联删除 join 行,文章不受影响**(join 表 FK `onDelete: cascade`);**重命名只改 `name`,`slug` 默认稳定**(改 slug 会变 URL,需显式操作并提示)。 | issue 要求「重命名/删除时保持数据完整」。 |
| D5 | **关联变更与发布/内容版本完全隔离**:assign 分类/标签**不触碰** `posts.status` / `scheduled_at` / `content_updated_at`(ADR 0004:taxonomy/visibility 变更不更新 `content_updated_at`)。 | 不污染发布状态机与翻译 stale 判定。 |
| D6 | **taxonomy CRUD 不写 `audit_events`**(普通后台内容管理,非敏感状态)。 | 审计表保留给会员/付款/管理员动作;避免噪音。 |

## 2. Schema 变更 `src/db/schema/index.ts`

```ts
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const postCategories = pgTable(
  "post_categories",
  {
    postId: uuid("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.categoryId] }),
    index("post_categories_category_idx").on(t.categoryId),
  ],
);

export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.tagId] }),
    index("post_tags_tag_idx").on(t.tagId),
  ],
);
// 导出类型 Category / Tag / PostCategory / PostTag
```

- 需要 import `primaryKey`（drizzle-orm/pg-core）。
- 迁移：`pnpm exec drizzle-kit generate`（纯新增表，低风险）。

## 3. Service 模块 `src/modules/taxonomy/index.ts`（新建）

```ts
// 分类 / 标签 CRUD（slug 唯一冲突 → ApiError(409, "slugTaken")）
listCategories() / createCategory({name,slug,sortOrder}) / updateCategory(id, patch) / deleteCategory(id)
listTags()       / createTag({name,slug})              / updateTag(id, patch)      / deleteTag(id)

// 文章关联（整组替换语义；单事务内 delete + insert，幂等）
setPostCategories(postId, categoryIds[]) : Promise<void>
setPostTags(postId, tagIds[])            : Promise<void>

// 读取
getPostTaxonomy(postId): Promise<{ categories: Category[]; tags: Tag[] }>
```

- `setPostX` **不更新 `posts` 任何列**(D5):只动 join 表。
- slug 生成/校验:建议提供一个 slugify 工具;创建时 slug 必填或由 name 派生,唯一约束兜底。

## 4. 内容查询接入 `src/modules/content/index.ts`

- `listPosts` 增加可选过滤:`opts.categorySlug?` / `opts.tagSlug?` → join `post_categories`/`post_tags` 过滤。**保持现有 `publishedOnly` / 可见性逻辑不变**。
- 文章详情/列表展示需要 taxonomy:可在 `getLocalizedPost` 旁新增 `getPostTaxonomy(postId)`,或让页面单独调 taxonomy service。
- ⚠️ 不要在 taxonomy 过滤里掺入 visibility 判定(D1);可见性仍由既有逻辑负责。

## 5. 后台 UI

- 新增 `src/app/admin/(dashboard)/taxonomy/page.tsx`(或拆 categories/tags 两页):分类、标签的列表 + 增删改,**照抄** `tier-manager.tsx` / `payment-method-manager.tsx` 的 client 组件 + API 路由范式。
- API:`/api/admin/categories`、`/api/admin/categories/[id]`、`/api/admin/tags`、`/api/admin/tags/[id]`,均 `requireAdmin()`。
- `post-editor.tsx` 加 **分类/标签多选**;保存时调 `setPostCategories` / `setPostTags`(可与文章保存同请求或独立请求,但**关联写入不得改 `content_updated_at`**)。

## 6. 前台展示（+ 可选过滤）

- `[slug]/page.tsx`:展示该文章的分类/标签。
- `posts/page.tsx`:可选支持 `?category=slug` / `?tag=slug` 过滤(复用 `listPosts` 新参数)。若 v1 不做前台过滤,在 PR 注明为后续。

## 7. i18n

`{zh,en,ja}.ts` 补:后台「分类/标签/新建/slug/排序」等 UI 文案、`slugTaken` 错误。(taxonomy **内容名称**本身单语言,见 D2。)

## 8. 测试

- service:CRUD;slug 唯一冲突 → 409;`setPostCategories/Tags` 整组替换 + 幂等;删除 taxonomy 级联清 join、文章保留。
- 隔离:assign taxonomy **不改** `posts.status` / `content_updated_at`(可做集成断言)。
- content:`listPosts({categorySlug})` 过滤正确,且不影响可见性/published 过滤。
- 路由:`requireAdmin` 鉴权。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build
```

## 10. PR

- base `main`,draft,标题 `feat(content): add tags and categories`。
- 描述声明:新增 4 张表 + 迁移、taxonomy service、后台管理、文章关联、前台展示;**注明 v1 名称单语言、taxonomy 不参与权限**。
- 关联 `Closes #10`。

## 11. 验收 checklist（对应 issue #10）

- [ ] 分类/标签独立 schema + 迁移
- [ ] 后台可增删改 + 文章可关联
- [ ] 关联变更与发布态/`content_updated_at` 隔离
- [ ] 重命名/删除保持数据完整(级联仅清 join,文章不丢)
- [ ] taxonomy 不充当访问边界
- [ ] slug 唯一冲突有稳定错误
