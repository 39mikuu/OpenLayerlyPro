# 代码规范

本文把项目现有约定成文,新增代码应遵循同样风格。工具链(Prettier / ESLint / commitlint / vitest)会自动校验大部分规则,提交前由 husky 钩子强制执行。

## 目录分层

| 目录 | 职责 |
|---|---|
| `src/app/` | Next.js App Router 路由与 API route。**route 只做参数解析与响应**,不写业务逻辑。 |
| `src/modules/` | 业务逻辑层,按域划分(`auth`、`payment`、`membership`、`content`、`file`、`storage`、`mail`、`security`、`system`、`site`、`download`、`user`)。 |
| `src/lib/` | 跨域通用工具(`api.ts`、`env.ts`、`rate-limit.ts`、`client.ts`、`utils.ts`)。 |
| `src/components/` | React 组件,按域分子目录(`admin`、`auth`、`payment`、`ui`)。 |
| `src/db/` | Drizzle schema 与迁移。 |

## 命名与导出

- **命名**:统一 camelCase(函数、变量),类型/类用 PascalCase。
- **导出**:`modules` 与 `lib` 一律使用 **named export**;Next.js 页面 / 布局 / route handler 用 **default export**(框架约定)。
- 函数入参较多时用对象参数(`input` 对象),而非长参数列表。

## 错误处理与 API 响应

- 业务错误抛 `ApiError(status, message)`(`src/lib/api.ts`),消息用中文。
- API route 用 `try/catch` 包裹,统一交给 `handleApiError(err)` 转换为响应;它会区分 `ApiError`、`ZodError`(返回 400 + 字段路径)与未知错误(500 中文兜底并 `console.error`)。
- 响应格式统一为 `{ ok: true, data }` / `{ ok: false, error }`,分别用 `jsonOk` / `jsonError` 构造。
- 入参一律用 **Zod schema** 校验后再进入业务逻辑。

```ts
export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());
    const data = await doSomething(body);
    return jsonOk(data);
  } catch (err) {
    return handleApiError(err);
  }
}
```

## 注释与日志

- 注释用中文;模块内用 `// ---------- 区块名 ----------` 分段。
- 复杂业务点标注依据(如 `// PRD §10.8`)。
- **敏感信息(secret、token、验证码、加密密钥)绝不输出到日志**。

## Import 顺序

由 `eslint-plugin-simple-import-sort` 自动排序并分组(第三方包 → `@/` 别名 → 相对路径,组间留空行),`eslint --fix` 会自动修复,无需手动维护。

## Server / Client 组件

- 默认 Server Component;需要交互/状态/浏览器 API 的组件在文件首行标注 `"use client"`。
- 运行时才能确定的值(如 Turnstile site key)由 Server Component 读取后以 props 下传,不依赖构建期内联的 `NEXT_PUBLIC_*`。

## 工具链

| 命令 | 用途 |
|---|---|
| `pnpm format` / `pnpm format:check` | Prettier 写入 / 仅检查(printWidth 100,2 空格,双引号,分号,多行尾逗号) |
| `pnpm lint` | ESLint(import 排序、`no-explicit-any` 告警等) |
| `pnpm test` / `pnpm test:watch` | vitest 单元测试 |
| `pnpm exec tsc --noEmit` | 类型检查 |

- **提交钩子**:`pre-commit` 对暂存的 `.ts/.tsx` 自动 `eslint --fix` + `prettier --write`;`commit-msg` 用 commitlint 校验。
- **commit message**:Conventional Commits 前缀(`feat`/`fix`/`docs`/`chore`/`test`/`refactor`/`style`/`ci` …)+ 中文描述,例 `feat(config): 新增 SMTP 后台配置项`。
- **测试**:纯逻辑模块(无 DB/网络依赖)应配套 `*.test.ts`,放在被测文件同目录;涉及单例状态或时间的逻辑用 `vi.useFakeTimers()` 与唯一 key 隔离(参考 `src/lib/rate-limit.test.ts`)。

## 文档约定

文档严格区分「已实现 ✅ / 计划中 🚧」,不把计划写成已完成。环境变量变更须同步 `src/lib/env.ts`、`.env.example` 与相关文档(见 dev-workflow.md)。
