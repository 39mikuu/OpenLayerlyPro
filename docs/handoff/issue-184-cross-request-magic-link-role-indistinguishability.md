Warning: truncated output (original token count: 17585)
Total output lines: 841

# Issue #184：跨请求 Magic Link 角色不可区分性规格

- **状态**：已完成（v28；历史实现前安全规格）
- **Issue**：[#184](https://github.com/39mikuu/OpenLayerlyPro/issues/184)（已以 `completed` 关闭）
- **Spec PR / merge**：[#186](https://github.com/39mikuu/OpenLayerlyPro/pull/186) → `58905079974f3819f49a7e679b5fd6448bba9a0b`
- **Implementation PR / merge**：[#197](https://github.com/39mikuu/OpenLayerlyPro/pull/197) → `5bbcac6c1629d97ce1fe90953a3e3f93fd730c32`
- **设计基线**：origin/main 80dbaa057a637ee88b7643da5b68f7671a57437c
- **变更类型**：Auth / anti-enumeration security fix；后续实现会包含 schema、migration、任务协议、运维 bundle 与文档变更

本文件曾是 Issue #184 的实现前权威规格，并作为 implementation PR #197 的验收依据。它保留当时的未来时态、Spec PR 范围和 rollout 要求，作为历史设计与安全证据；不应被读作仍未完成的任务、当前生产运维手册，或 v1.2 已正式发布的声明。

## 1. 权威来源、范围与强制语义

实现 PR 必须同时遵守：

- Issue #184 的 required invariants；
- docs/handoff/issue-175-magic-link-session-atomicity.md；
- docs/handoff/issue-176-admin-magic-link-boundary.md 中未被本文件明确 supersede 的消费期边界；
- docs/handoff/harden-s4-auth-rate-limiting.md；
- docs/adr/0002-audit-and-event-strategy.md 与 docs/adr/0003-durable-task-and-outbox-boundary.md；
- 实现时的最新 main、AGENTS.md 与本文件。

如有冲突，Issue #184 的安全不变量、本文件的明确 MUST/MUST NOT、以及已接受 ADR 优先。实现 PR 必须从合并本 Spec PR 后的最新 main 新建，不得从本分支携带生产代码。

本文中的“必须”“MUST”“不得”“仅当”均为可验证要求；“旧版本”指 80dbaa057a637ee88b7643da5b68f7671a57437c 所代表的未实现本协议的应用、dispatcher、运维 bundle 或其等价二进制。

### 1.3 与 Issue #176 的边界

本规格明确取代 #176 中依赖**公开请求时**角色读取的 Magic Link 请求期守卫，以及其“0 task”中与 Issue #184 冲突的宽泛表述：在本协议中，所有接受的公开请求都创建一个 intake 任务；当前 admin 在实际 mint 授权边界仍必须产生 0 token、0 **投递任务**、0 SMTP。公开路径不得持久化角色快照、suppression reason 或可反推角色的标志。

#176 的消费期 admin guard、消费原子性、session/cookie 边界和统一 invalid/replayed 公开语义仍然强制有效。后续 implementation PR 必须在 #176 handoff 顶部加入 supersession 指针，并令 verify/consume 同时要求 active/delivered；Transaction B 在当前角色为 admin 时不得激活 candidate。不得用本文件的异步 intake 解释为放宽这些消费期边界。

### 1.1 Issue #184 不变量

1. 重复的公开 Magic Link 请求不得通过状态、响应体、响应头、latency class 或请求者可观察的相关限流状态区分 admin、member/fan 与 unknown 邮箱。
2. 当前为 admin 的邮箱不得 mint token、不得入队 Magic Link **投递任务**，不得发送 Magic Link 邮件。
3. 不得给 admin 邮箱发信；不得削弱来源 IP 防护；不得让攻击者廉价耗尽其他用户的有效登录能力。
4. member/fan 的 dedupe、任务 fencing、重试与正常登录可用性必须保持。
5. 并发和限流状态必须由真实 PostgreSQL 测试验证。

### 1.2 术语

| 术语 | 规范定义 |
|---|---|
| intake 任务 | auth.magic_link_request。每个已接受的公开请求均创建；只携带 requestId；不携带 token；永不调用 SMTP；不是投递任务。 |
| 投递任务 | auth.magic_link_email。携带 tokenId、encryptedToken 等投递所需数据，可能调用 SMTP。 |
| legacy v1 | 旧同步请求路径及没有 deliveryProtocol 的既有投递 payload。 |
| protocol v2 | 有 payload_json 顶层 deliveryProtocol: 2 的 delivery-aware 协议。 |
| candidate | protocol v2 中 delivery_state=pending 的 magic_link_tokens 行。 |
| reservation | candidate 上同时非 NULL 的 delivery_reservation_id 与 delivery_reservation_until。它是 promotion fence，不是 token TTL。 |
| fence-blocking candidate | 任意 delivery_state=pending 且 delivery_reservation_id 或 delivery_reservation_until 非 NULL 的 candidate。数据库 pair CHECK 要求两列同时非 NULL；即使 task 已 terminal、until 已过或 candidate 已超龄，它仍阻断该邮箱的新 mint 和管理员晋升。 |
| ownership generation | delivery_reservation_id UUID。每次成功取得投递所有权必须生成新的、不可复用的 UUID。 |
| full quiescence | 已证明所有可能执行 SMTP、dispatcher、管理提升或旧运维 bundle 的实例均已停止且禁止重启的维护窗口。 |

代码、测试、PR 描述与文档不得把 intake 任务称为投递任务。

## 2. 安全模型与公开路径

攻击者可以使用任意数量来源 IP、并发请求并测量状态码、响应体、响应头及端到端延迟；攻击者不能读取数据库、任务、日志、审计记录或目标邮箱。

默认安全协议的公开请求路径必须满足：

1. 路由层维持现有 source/IP 门禁；它是唯一允许返回 429 的门禁。
2. 路由必须在其余成功请求上恒返回同一 accepted-shaped 响应。
3. 公开路径不得读取 users、magic_link_tokens 或 tasks；不得取得按邮箱 advisory lock；不得构造或推进 request-code-email-ip 限流 key。
4. 对每个请求，公开路径必须在同一数据库事务内插入一行 magic_link_requests 与一个 auth.magic_link_request 任务。两者要么同时提交，要么同时回滚。
5. 公开路径必须在事务提交后记录同构的 magic_link_requested 事件；事件 payload 只允许 requestId 与以 auth-log-email purpose 生成的 emailDigest。

公开路径可以读取密钥配置和 SMTP 配置，但其外部行为必须精确定义为：

- 不得进行任何与目标邮箱、账户存在性或角色相关的 SMTP、HTTP、对象存储或第三方 I/O；
- 首次读取 MAGIC_LINK_SECRET_FILE 等本地 secret 文件可以发生，但该读取必须与请求目标无关，且部署必须允许在接流量前预热；
- 配置数据库读取和本地 secret 读取的次数、失败响应与路径不得依赖目标邮箱；
- SMTP 只能在投递任务中、数据库事务外执行。

### 2.1 rollout gate 环境变量

MAGIC_LINK_INTAKE_ENABLED 是一次部署门禁，而不是普通功能开关：

| 环境变量 | 解析 | 默认值 | 强制语义 |
|---|---|---:|---|
| MAGIC_LINK_INTAKE_ENABLED | 精确 true 或 false；其他值启动失败 | false | false 只允许 legacy v1 路径；true 才允许创建或执行 protocol v2 intake。 |
| TASK_AUTH_INTAKE_MAX_PER_BATCH | 整数，最小 1，最大 TASK_BATCH_SIZE | 4 | 无论 intake 是否启用均不得为 0，避免 rollback drain 把残余 intake 永久饿死。 |

默认 false 是 migration 后的安全兼容状态，不是完成 Issue #184 的运行状态。生产部署只有在第 9 节阶段 B 的全部证明成立后，才可将该变量切换为 true。任何把 true 当作默认 rollout 行为的实现都是不合格实现。

在 true 路径中，公开路径的固定数据库形状为一次写事务中的 request INSERT 与 task INSERT；它不得因邮箱角色、已有 token、任务状态或预算而变化。false 路径保留 legacy 行为，只可用于阶段 A、rollback drain 或经过记录的紧急降级，且不声称满足本 Issue 的不可区分性保证。

### 2.2 可观察限流与 anti-DoS 边界

true 路径中的每个非来源限流请求必须返回逐字节相同的 200 accepted-shaped 响应与相同响应头集合。公开路径只可推进既有 request-code-ip 或 request-code-unresolved source bucket；它不得读取、写入或间接改变 request-code-email-ip 状态。任何 admin/member/unknown 差异只能在异步 worker 内部产生，不能反映到请求者可观察面。

mint budget 必须绑定 normalized email 与可信请求 IP，并只在可信 IP 可用时执行。它必须在同邮箱 advisory lock 内以已提交 minted_at 计数。identity 为 unresolved 时不得改用纯 email 预算，因为纯目标预算会让任意攻击者跨来源耗尽受害者的登录能力；此时仍由来源级门禁、pending fence 与 dedupe 保护。该差异不得改变公开响应、响应头或 source limiter 的角色无关语义。

所有角色的 accepted 请求都必须写同构 magic_link_requested 审计/事件记录。只对已 mint 请求写事件会重新形成服务端持久角色标记，因而禁止。

## 3. 数据模型与数据库约束

### 3.1 magic_link_requests

后续 migration 必须创建至少以下列：

~~~sql
create table magic_link_requests (
  id uuid primary key,
  email text not null,
  locale text,
  redirect_path text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  minted_at timestamptz,
  minted_token_id uuid
);

create index magic_link_requests_mint_budget_idx
  on magic_link_requests (email, ip, minted_at desc)
  where minted_at is not null;

create index magic_link_requests_cleanup_idx
  on magic_link_requests (
    greatest(created_at, coalesce(minted_at, created_at)),
    id
  )
  where resolved_at is not null;

create table magic_link_mint_ledger (
  request_id uuid primary key,
  minted_token_id uuid not null,
  delivery_task_id uuid not null,
  minted_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table magic_link_delivery_dispositions (
  candidate_id uuid primary key,
  request_id uuid not null,
  minted_token_id uuid not null,
  delivery_task_id uuid not null,
  final_state text not null
    check (final_state in ('cancelled', 'superseded', 'abandoned')),
  reservation_id uuid,
  recorded_at timestamptz not null default now()
);
~~~

该表不得包含 role、suppression reason、admin 标记或其他可持久化角色判定。minted_token_id 是成功 mint 时写入后不可变的 UUID 审计锚点，故**不得**使用 ON DELETE SET NULL 或任何 cleanup UPDATE 将它清空；它在 mint 事务中验证 candidate 存在，随后允许作为历史 disposition 指针保留。magic_link_mint_ledger 是该锚点的不可变、request-cleanup 后仍可读取的副本；magic_link_delivery_dispositions 以 candidate_id 为唯一键保存最终 cancelled/superseded/abandoned disposition。两张表必须使用与 token/request/task 相同的 UUID 值，但不使用会在清理时级联删除或置 NULL 的外键。mint budget 只能以已提交的 minted_at 作为记账依据；不得以 token 行存在、task 行存在或 minted_token_id 是否为空替代。

对 minted request，resolved retention 的最小安全下界必须是“minted_at + 配置的完整 mint-budget window”；启动/配置校验必须拒绝任何比该 window 更短的 request retention。minted request 只有在完整 budget window 已过且对应 magic_link_mint_ledger 已存在时才可删除；它无需等待 candidate 状态，因为 ledger 是后续 rollback/disposition 的权威关联。ledger 必须至少保留到 candidate 物理删除和 disposition-audit retention 均结束；candidate 物理删除必须有对应 ledger 与唯一 disposition record。因而 request 行在 budget window 内、ledger 在 request cleanup 后分别是 mint budget、rollback 以及审计的权威关联；只有这些条件均满足后 request 缺失才是第 4.1 节所述正常 no-op。

### 3.2 delivery lifecycle 与 reservation generation

后续 migration 必须为 magic_link_tokens 增加：

~~~sql
alter table magic_link_tokens
  add column delivery_state text,
  add column delivered_at timestamptz,
  add column superseded_at timestamptz,
  add column delivery_reservation_id uuid,
  add column delivery_reservation_until timestamptz;

update magic_link_tokens
set delivery_state = 'active',
    delivered_at = coalesce(delivered_at, created_at);

alter table magic_link_tokens
  alter column delivery_state set default 'active',
  alter column delivery_state set not null,
  alter column delivered_at set default now();

alter table magic_link_tokens
  add constraint magic_link_tokens_delivery_state_check
    check (delivery_state in ('pending', 'active', 'superseded', 'cancelled')),
  add constraint magic_link_tokens_delivery_timestamp_check
    check (
      (delivery_state = 'pending' and delivered_at is null)
      or (delivery_state = 'active' and delivered_at is not null)
      or delivery_state in ('superseded', 'cancelled')
    ),
  add constraint magic_link_tokens_reservation_pair_check
    check (
      (delivery_reservation_id is null)
      = (delivery_reservation_until is null)
    ),
  add constraint magic_link_tokens_reservation_state_check
    check (
      delivery_reservation_id is null
      or delivery_state = 'pending'
    );

create index magic_link_tokens_pending_cleanup_idx
  on magic_link_tokens (created_at, id)
  where delivery_state = 'pending'
    and delivery_reservation_id is null;

create index magic_link_tokens_stuck_reservation_idx
  on magic_link_tokens (created_at, id)
  where delivery_state = 'pending'
    and delivery_reservation_id is not null;
~~~

delivery_reservation_id 是所有权凭据；delivery_reservation_until 仅用于续租、可观测性和告警。时间经过、时间戳到期、JavaScript 往返延迟或无心跳都不得自动使所有权失效、解除 promotion fence 或授权其他 worker 清理该 reservation。

状态转换只能是：

~~~text
pending -> active | superseded | cancelled
active  -> superseded
~~~

离开 pending 的事务必须同时清空 reservation ID 与 reservation until。pending 的两列可以同时为 NULL，表示尚未开始 SMTP；一旦二者任一非 NULL，数据库约束要求二者均非 NULL，且该 candidate 被视为有 reservation。

migration 必须在同一原子 DDL/data migration 中按“添加 nullable 列 -> 回填历史行 -> 设置 delivery_state DEFAULT active / NOT NULL 和 delivered_at DEFAULT now() -> 添加 CHECK/索引”的顺序执行。CHECK 不得在 delivery_state 可为 NULL 时依赖 SQL 的 UNKNOWN=pass 语义。compatibility period 中旧代码未写新列时，数据库默认值必须产生 active/delivered token；protocol v2 INSERT 则必须显式写 pending 与 delivered_at=NULL。该兼容默认值只保证 legacy token 的可用性，**不得**被解释为允许旧 verifier、旧 consumer、旧管理路径或旧运维 bundle 与 protocol v2 并存。

### 3.3 protocol v2 payload 和 queue class

deliveryProtocol 是 payload_json **顶层**的非敏感协议元数据。一个 protocol v2 payload 的形状必须为：

~~~json
{
  "version": 1,
  "deliveryProtocol": 2,
  "tokenId": "candidate UUID",
  "encryptedToken": "ciphertext",
  "locale": "optional locale"
}
~~~

只有 encryptedToken 是加密 token 内容。不得把 deliveryProtocol 描述为加密 payload 内字段。后续 TypeScript task payload discriminated union、enqueue helper、handler parser 与下列数据库 CHECK 必须使用这个相同结构：v2 有顶层 deliveryProtocol=2、tokenId、encryptedToken，且 v2 **不得**携带 email；legacy v1 不含 deliveryProtocol。

migration 必须将 protocol v2、auth_delivery_v2 与 auth.magic_link_request/auth_intake 双向绑定，且不得让 SQL NULL 使 CHECK 通过：

~~~sql
check (
  coalesce(
    case
      when kind = 'auth.magic_link_request'
      then queue_class = 'auth_intake'
        and not coalesce(payload_json ? 'deliveryProtocol', false)
        and not coalesce(payload_json ? 'email', false)
      when kind = 'auth.magic_link_email'
        and coalesce(payload_json ? 'deliveryProtocol', false)
      then jsonb_typeof(payload_json->'version') = 'number'
        and payload_json->>'version' = '1'
        and jsonb_typeof(payload_json->'deliveryProtocol') = 'number'
        and payload_json->>'deliveryProtocol' = '2'
        and jsonb_typeof(payload_json->'tokenId') = 'string'
        and jsonb_typeof(payload_json->'encryptedToken') = 'string'
        and not coalesce(payload_json ? 'email', false)
        and (
          not coalesce(payload_json ? 'locale', false)
          or (
            jsonb_typeof(payload_json->'locale') = 'string'
            and payload_json->>'locale' in ('zh', 'en', 'ja')
          )
        )
        and queue_class = 'auth_delivery_v2'
      when kind = 'auth.magic_link_email'
      then queue_class = 'transactional'
      else queue_class not in ('auth_delivery_v2', 'auth_intake')
        and not coalesce(payload_json ? 'deliveryProtocol', false)
    end,
    false
  )
)
~~~

legacy payload 没有 deliveryProtocol，继续位于 transactional；auth.magic_link_request 必须且只能位于 auth_intake。deliveryProtocol=2 必须是 JSON number、version=1、tokenId/encryptedToken 必须是 string，locale 若存在必须是 SUPPORTED_LOCALES 成员，且 v2/intake 均不得携带 email。deliveryProtocol 缺失时，handler 必须显式选择 legacy v1 handler；它不得把旧 payload 当作 v2，也不得因为阶段 A/rollback 而跳过仍待处理的 legacy delivery。deliveryProtocol=2 时，handler 必须且只能选择 v2 handler。未知 deliveryProtocol 值或不合形状的 v2 payload 必须由 enqueue/migration 的数据库 CHECK 拒绝；若历史损坏行绕过约束而存在，handler 必须将其变为不 SMTP 的安全 terminal failure 并产生无敏感信息诊断。

后续 migration/handler 测试必须预置一个 migration 前的 auth.magic_link_email transactional payload（无 deliveryProtocol），证明它在阶段 A 与 rollback drain 中仍由 legacy handler 可确定地处理；还必须验证 auth.magic_link_request 与 auth_intake 的双向拒绝、v2/email/queue 三元映射、v2 携带 email 或错误 JSON type/locale 的拒绝，以及 unknown protocol 的 DB 拒绝。

## 4. intake resolver 与原子 mint

### 4.1 锁顺序和 request 行

intake handler 的锁顺序必须恒定为：

~~~text
task FOR UPDATE
-> magic_link_requests FOR UPDATE
-> pg_advisory_xact_lock(normalized email)
-> magic_link_tokens FOR UPDATE
-> users FOR UPDATE
~~~

task 行必须从当前 fence.taskId 以 FOR UPDATE 读取并在提交前保持锁定。handler 必须在读取 request 行前与等待 advisory lock 后各验证一次 task 的 status、locked_by、lease_until 和 kind。

若 task 已被其他 worker 取得或已终态，旧执行必须成功 no-op；若 task 仍由本 worker 持有但 lease 已过期，handler 必须抛可重试错误，绝不能成功结束。handler 不得修改通用 markTaskSucceeded 的语义来规避此要求。

request 行必须以 FOR UPDATE 锁定。这样 cleanup 的 FOR UPDATE SKIP LOCKED 不会删除一个已经被读取、但正在等待同邮箱 advisory lock 的 request。

若 request 行不存在，handler 必须不 mint、不入队投递任务并安全结束。它**不得无条件**定义为 invariant violation：已 resolved 的 request 在 retention cleanup 后消失，而对应 task 的延迟重试是正常、可预期的 no-op。实现可以输出不含邮箱/角色的节流诊断，但不得把该正常情形升级为安全告警，也不得据此创建补偿 token。

### 4.2 非 mint 分支

在持锁事务内，intake 必须读取该邮箱候选 token 与用户角色。以下任一条件成立时，必须仅更新 request.resolved_at，且 minted_at 与 minted_token_id 保持 NULL：

- 当前锁定角色为 admin；
- 已有 live pending candidate；
- 已有 fence-blocking candidate；即任意 pending candidate 的 reservation 任一列非 NULL。该谓词不依赖 delivery_reservation_until、task 是否 succeeded/dead 或 candidate 年龄；
- 仍在 dedupe window；v2 的唯一锚点是最近一次**未消费、未过期** active token 的已提交 delivered_at，而不是 candidate.created_at、request.created_at、task run_after 或 SMTP 开始时间；
- mint budget 已耗尽；
- 首次 claim 时请求已超过 MAGIC_LINK_REQUEST_MAX_AGE_MINUTES；
- candidate/task 引用不一致，且无法安全证明可 mint。

对 admin，增量必须为零 token、零投递任务、零 SMTP。公开 intake 任务和 request 行仍按公开路径产生，因而不泄漏角色。

对 v2，dedupe/spacing 必须以 `now() - delivered_at < REQUEST_CODE_SEND_DEDUPE_SECONDS` 判断，并且只读取 delivery_state=active、delivered_at 非 NULL、consumed_at IS NULL、expires_at > now() 的已提交投递结果。migration 回填的 legacy active token 已有 delivered_at=created_at，因而保持可定义的兼容锚点；pending/fence 始终按前述独立谓词抑制，不得因为其 created_at 超出 dedupe window 而放开。不得使用 candidate.created_at 作为 v2 dedupe 锚点，否则 SMTP/queue 延迟可使刚激活的链接被立即替换。

超龄只在该 intake task 的首次有效 claim（attempt=1）判定；后续因 worker/数据库故障的 retry 不得因已经过了一段排队时间而改写该判定。首次超龄必须只写 resolved_at、发出不含邮箱/角色的节流告警，并不得 mint。实现必须单独测试“首次 claim 超龄”与“首次及时、随后 retry 超龄”两种情况。

### 4.3 成功 mint 的同事务记账

异步 mint 的所有请求派生字段必须来自已 FOR UPDATE 锁定的 request 行，而不是已经结束的 HTTP 请求。candidate 的 redirect_path 必须再次调用当时的 normalizeMagicLinkRedirectPath(request.redirect_path)：返回 null 时写 null 并使用既有安全默认跳转，绝不得原样复制历史值。v2 delivery payload 的 locale 仅当 request.locale 属于 SUPPORTED_LOCALES 时才可带入；不支持、空或历史污染值必须**整键省略**，不得改写为默认 locale、null 或任意字符串。

成功 mint 只能在一个数据库事务内完成，下列顺序是强制的：

1. 在同邮箱 advisory lock 内，以已提交 minted_at 计数执行 mint budget 检查。
2. 插入一个 delivery_state=pending、delivered_at=NULL、reservation 两列均为 NULL 的 candidate token，并显式写 `expires_at = 'epoch'::timestamptz`。现有 expires_at NOT NULL 约束仍然有效；该 epoch 值是不可授权、不启动 TTL 的 placeholder，绝不得被当作真实 token expiry 或 rollout compatibility gate。
3. 插入唯一对应的 auth.magic_link_email protocol v2 delivery task，queue_class=auth_delivery_v2。
4. 更新同一已锁定 request 行：

~~~sql
update magic_link_requests
set resolved_at = now(),
    minted_at = now(),
    minted_token_id = :candidate_id
where id = :request_id
  and resolved_at is null
returning id, minted_at, minted_token_id;
~~~

5. 插入 magic_link_mint_ledger，精确写入 requestId、candidateId/mintedTokenId、deliveryTaskId 与同一 minted_at；不得在事务外补写该 ledger。
6. 仅当第 2、3、4、5 步都成功且 request update 恰好返回一行时，事务才可提交。

candidate、delivery task、resolved_at、minted_at、minted_token_id 与 mint ledger 必须全有或全无。task INSERT、request update、ledger INSERT 影响零行/失败、token INSERT 失败、事务冲突、进程崩溃或提交失败时，事务必须回滚；不得留下孤立 candidate、孤立 delivery task、已记账未投递 token、未记账已投递 token 或无 request 锚点的 candidate。

epoch placeholder 会使 exact-base 旧 verifier/consumer 的既有 `expires_at > now()` 谓词拒绝 pending token，但它**不**保护 superseded/cancelled、管理员写路径或旧运维 bundle，因而不是完整数据库兼容保护，更不得用它允许任何旧实例继续运行。若后续实现额外选择完整数据库兼容保护，仍必须满足第 9…5585 tokens truncated…rminal hooks

magic_link_requests 的普通 retention cleanup 必须只选择 resolved_at 非 NULL 的行，并以 FOR UPDATE SKIP LOCKED 删除。对 minted request，它还必须执行第 3.1 节的完整 budget-window 与 mint-ledger 存在谓词；不得因 resolved_at 非 NULL 就提前删除。未 resolved request、pending/processing/retryable failed intake 与 dead intake 必须保留其 durable payload state。成功 intake task 可以在同一 retention window 后有界删除；dead intake task 必须保留到显式 retry 或审计 disposition。

auth_intake 进入 dead 后必须由 task finalization hook 或 periodic reconciler 写入实际告警面；不能只留在数据库中。该告警必须以 task ID 为 durable 去重键、只在首次 dead 或节流周期后发送，并且只含 task ID、attempts、age、状态与聚合计数，绝不含邮箱、角色、token、IP、user-agent 或 request payload。告警写入/发送失败不得改变 dead 状态，后续扫描必须可重试。

terminal v2 delivery candidate 的普通 cleanup 必须由 candidate 驱动，而不是由所有 terminal task 驱动，避免早期成功 task 永远占满扫描批次。task 最终状态提交后，task 子系统必须在提交后运行 hook/periodic reconciler；它不得在 handler transaction、advisory-lock 临界区或 SMTP 期间删除 candidate。hook/reconciler 失败不得回滚已提交的 task terminal state，下一轮必须可重试。candidate 的物理删除必须同时有 matching mint ledger 和 matching unique disposition record，并在 disposition-audit retention 后才可发生；仅把 request.minted_token_id 静默设 NULL 不构成合法 cleanup。

### 7.2 production rollback disposition bundle

后续实现必须提供并打包一个 production-image maintenance bundle，至少包含：

- cleanup-aged-null：循环执行 ordinary NULL-reservation cleanup；
- list-terminal：以 keyset 分页列出所有 terminal protocol-v2 pending candidate，不按 age 或 reservation 值遗漏成员；
- count：分别统计 aged-null 与 terminal-pending scope；
- verify-zero：在相应 count 非零时非零退出；
- abandon：只在第 9.4 节 full-quiescence 审计条件成立时逐项处置 non-NULL fence。socket-cleared 不是 maintenance abandon 条件：它只表示原 processing owner 已依第 5.5 节用精确 claim 与 generation 将两列实际清为 NULL；此类已 NULL candidate 只能走 ordinary cleanup。

rollback 固定证据链必须为：

~~~text
cleanup-aged-null --confirm
-> count --scope aged-null == 0
-> verify-zero --scope aged-null
-> list-terminal from empty cursor until exhausted
-> retry or audited abandon every item
-> count --scope terminal-pending == 0
-> list-terminal again from empty cursor is empty
-> verify-zero --scope terminal-pending
~~~

任一非零退出、非空 page/cursor、缺失审计记录或 non-NULL reservation 未经 quiescence 处置都必须阻断 rollback。bundle 必须由生产 Docker image 构建、可在无源码、无 pnpm、无 tsx 的 runner 中直接执行，并有 smoke test。

## 8. task claim 语义

protocol v2 不能用一个混合的 run_after、priority、id 排序替代既有 stale-first 语义。对于每个参与共同领取的目标 queue-class 集合，claim helper 必须严格分两阶段：

1. 先在**整个目标集合**内选择 status=processing 且 lease_until 已过的 stale task，排序为 lease_until、priority、id；
2. 只有第一阶段没有可领取 task 时，才在同一集合内选择 run_after 已到的 pending/failed task，排序为 run_after、priority、id。

transactional 与 auth_delivery_v2 的共享 reservation/slot 必须把二者作为同一目标集合，因此 stale auth_delivery_v2 必须先于 due transactional，反之亦然。不得使用 union 后按 COALESCE(lease_until, run_after) 或 run_after 全局排序；那会使 due task 插队到 stale task 前。

auth_intake 必须是独立 queue class，并在**领取前**实施 TASK_AUTH_INTAKE_MAX_PER_BATCH 上限；它不得放入 transactional 或 default 而使公开洪泛 FIFO 阻塞 Magic Link 投递、登录验证码、支付或发布任务。既有 transactional reserved、notification/default minimum 和 maintenance 约束必须保留；intake 不得在相应类别有可领取任务时侵占其保证槽。auth_intake cap 必须至少为 1。任何 rollback drain 在 auth_intake 尚有 pending、processing 或 retryable failed residue 时不得设置 cap=0。

## 9. 两阶段部署、rollback 与 quiescence

### 9.1 为什么旧实例不安全

仅让旧 dispatcher 看不到 auth_intake/auth_delivery_v2 不构成安全 rollout。旧版本仍会：

- 旧 verifyMagicLinkToken()/consumeMagicLinkToken() 不检查 delivery_state；v2 pending 的 epoch placeholder 只会让 exact-base 当前 expires_at 谓词拒绝它，不能成为版本共存证明；
- 让旧 consumeMagicLinkToken() 消费仍未过期的 superseded token；对 pending/cancelled 的拒绝若发生，也只依赖 epoch expiry 而非 delivery_state；
- 让旧 setupSite()/changeAdminEmail() 无视 SMTP reservation promotion fence；
- 让旧 scripts/admin-reset.mjs 或 production admin-reset bundle 直接升 admin；
- 让旧 Web/API 同步 intake 与新状态机并存，恢复跨请求角色信号或破坏 token lifecycle。

因此新队列对旧 dispatcher 的隔离只能保护 claim 解析；它不能保护 verifier、consumer、管理写路径或运维命令。

### 9.2 阶段 A：兼容部署

阶段 A 必须按以下顺序完成：

1. 执行兼容 migration：添加 lifecycle、reservation generation、queue class、request table、索引和 alert-dedup state；历史 token 必须保守回填为 active/delivered。
2. 部署**全部**新版本应用代码，并在每个新 Web/API、dispatcher、管理操作和 production image 运维环境强制设置：

~~~text
MAGIC_LINK_INTAKE_ENABLED=false
TASK_AUTH_INTAKE_MAX_PER_BATCH>=1
~~~

3. 阶段 A 中新版本不得创建 protocol v2 intake、candidate 或 v2 delivery task；它只能执行 legacy v1 兼容路径。
4. 建立版本 inventory 并等待旧版本完全退出。inventory 必须逐项证明零旧版本：
   - Web/API 实例、sidecar、serverless revision；
   - task dispatcher、worker、CronJob 和重试 job；
   - 后台管理、site setup 与管理员邮箱修改的执行环境；
   - 生产镜像中可通过 docker exec、Kubernetes job、CI、恢复镜像或人工命令启动的 admin-reset、rollback、维护 bundle；
   - 自动重启控制器、待执行 job 和缓存的操作入口；旧 image tag 可以保留用于紧急 rollback，但部署准入、运维凭据和调度配置必须证明它不能在阶段 B 后被重新实例化。
5. 对每项退出证明必须记录 image digest/revision、实例 ID、停止事件、无重启策略或已禁用的调度源。仅观察 queue 为空、lease 过期或旧 worker 没有领取新队列均不足。

### 9.3 阶段 B：启用新协议

只有阶段 A 的旧版本退出证明完整且由部署负责人记录后，才可进行第二次配置发布：

~~~text
MAGIC_LINK_INTAKE_ENABLED=true
TASK_AUTH_INTAKE_MAX_PER_BATCH>=1
~~~

该配置发布必须重启/滚动所有新版本进程，因为 getEnv() 会缓存环境。启用前和启用后必须确认所有活跃 Web/API、dispatcher、管理操作与可执行运维 bundle 都来自支持 protocol v2 的同一批准版本集合。

若任意旧版本、旧 admin-reset bundle 或无法证明版本的操作环境仍存在，阶段 B 必须 BLOCKED。实现可以增加数据库级兼容保护，但它必须明确证明 pending 对旧读取路径不可消费、非 active token 被数据库拒绝消费；即使增加，该保护也**不得替代**阶段 A/B 门禁。

### 9.4 rollback

rollback 必须先停新 intake，再由新版本完成 drain，最后才允许旧镜像：

1. 通过所有新版本实例的 restart/rollout 将 MAGIC_LINK_INTAKE_ENABLED=false；在所有实例确认读取 false 前不得认为新增已停止。
2. 保持 TASK_AUTH_INTAKE_MAX_PER_BATCH 至少为 1，直到 auth_intake 的 pending、processing 与 retryable failed residue 均为零。不得以 cap=0 伪造 drain。
3. 用新版本 worker 处理或明确处置 dead intake；request row 已经因 resolved retention cleanup 缺失时可作为正常 no-op，但不存在 request 的未 resolved 状态不得被当作已发送。
4. 普通 cleanup 只能处理 reservation NULL 的 terminal candidate。任何 non-NULL reservation 必须阻断 rollback，直到原 generation owner 安全清除，或进入 full quiescence。
5. full quiescence 必须停止并禁止重启全部可调用 SMTP、dispatcher、管理员提升和旧/新运维 bundle 的实例；部署平台必须记录零实例证明，并证明不存在仍可能在暂停后恢复的 SMTP I/O、socket 或 job。随后只允许一个 one-shot maintenance command（不得启动或 import dispatcher 或 mail transport）在 task -> candidate 锁顺序下逐项审计 disposition：它必须重新验证 task 为允许的 terminal 状态 succeeded 或 dead、candidate 仍 pending 且 consumed_at IS NULL、candidate/task/payload 关联正确、reservation ID 精确匹配审计输入，且不存在 live/retryable 引用；若对应 request 行仍保留，其 minted_token_id 必须精确匹配 candidate；若该 resolved request 已被 retention 删除，命令必须读取并精确匹配 magic_link_mint_ledger，缺失或不匹配 ledger 必须非零退出而不是视作正常。验证通过时，该命令必须在**同一事务**把 candidate 转为 cancelled、将两列 reservation 置 NULL，并从 ledger INSERT candidate 唯一的 magic_link_delivery_dispositions(final_state='abandoned') record；它不得 mint、激活、supersede 或提升 admin。任一验证失败、ledger/disposition INSERT 失败、进程崩溃或提交失败必须整体回滚并保留原 non-NULL fence。重试只有在重新取得 full-quiescence 证据后才可执行；已由同一 candidate/reservation ID 的 disposition record 完成的 item 必须幂等 no-op，其它状态差异必须非零退出。审计记录必须包含 task ID、candidate ID、reservation ID、原 until、quiescence evidence、停止的实例集合、操作者、时间和影响行数。
6. 在任何旧 Web/API/verifier/consumer 镜像可运行前，必须中和所有 protocol v2 non-active token，使旧代码的未消费且未过期谓词不能复活 pending、superseded 或 cancelled token。中和必须是可审计事务，且只可执行下列等价更新：

~~~sql
begin;
update magic_link_tokens
set expires_at = now()
where delivery_state in ('pending', 'superseded', 'cancelled')
  and consumed_at is null
  and expires_at > now()
returning id, delivery_state;
-- Write the rollback audit record for exactly these IDs before COMMIT.
commit;

select count(*)
from magic_link_tokens
where delivery_state in ('pending', 'superseded', 'cancelled')
  and consumed_at is null
  and expires_at > now(); -- MUST be 0 before old code can run
~~~

该操作不得触碰 active token、不得清除 reservation、不得改写 consumed_at 或 delivery_state。审计记录必须包含 exact affected IDs/count、操作者、时间和 rollback evidence；验证 count 非零必须阻断旧镜像。
7. 仅在所有 intake residue、v2 live/retryable delivery、terminal pending candidate 和非 active token 门禁均为零后，才可部署旧镜像。migration 与新表不得裸 DROP。

rollback 恢复了 Issue #184 的 legacy signal，必须在运行记录中明确说明。它不是接受“短暂安全残余”的理由。

## 10. 可观察性与 latency 验证

公开请求的 admin/member/unknown 三组必须拥有相同响应状态、响应体、响应头、路由 limiter 行为和结构性数据库路径。实现必须对 route 级 source/IP limiter 保持既有保护；Magic Link 本身不得改变 request-code-email-ip 状态。

latency 验证必须使用独立的高容量本地/预发 source 配置，而不是复用低 cap 浏览器冒烟配置。例如对单一来源执行 3 组各 200 个样本时，REQUEST_CODE_IP_RATE_MAX 必须至少覆盖 600 次请求加热身量；固定测试配置可设为 750，并让窗口覆盖全部采样。admin、member、unknown 每组必须实际获得至少 200 个有效 accepted 样本，报告 p50/p90/p99 和样本数。cap 只有 20 或 30 的配置不得被用作该结论证据。

stuck-fence、dead intake、超龄和 rollback 告警必须不含明文邮箱、角色、token、IP 或 user-agent。恢复后因陈旧 intake 触发的超龄告警可按恢复事件批次解释，但不得关闭该告警机制。

## 11. 必须覆盖的测试矩阵

后续 implementation PR 必须用真实 PostgreSQL 运行下列测试，并把 exact head、命令和结果写入 PR。

### 11.1 混合版本与启用门禁

- 以 exact base 80dbaa057a637ee88b7643da5b68f7671a57437c 的旧 verifier 读取新的 pending token，证明它只因 epoch expiry predicate 拒绝、并不识别 delivery_state，同时证明阶段 B gate 在旧实例存在时拒绝启用；
- 旧 consumer 尝试消费 pending token，必须只因 epoch placeholder 被拒绝，不能被误报为 state-aware 防护；
- 旧 consumer 尝试消费仍未过期的 superseded token，证明旧代码不识别其 lifecycle 并可能接受；对 cancelled token 的 attempt 必须断言其拒绝仅来自 epoch placeholder，而非 state-aware 防护；
- 旧 setupSite/changeAdmin 写路径与新 SMTP reservation 并发；
- 旧 production admin-reset bundle 与新 reservation 并发；
- 阶段 A 的 true 以外配置不得创建 v2 intake；
- 只有全部旧 Web/API、dispatcher、管理操作与运维 bundle 已退出后，阶段 B 才可启用；
- 若实现选择数据库级兼容保护，分别证明它阻止旧读取/消费，但仍证明它不能替代上述 rollout gate。

旧版本兼容测试必须使用可审计的 exact-base fixture 或由该 base 构建的 artifact，不能仅用“行为类似”的新代码 stub。

### 11.2 mint 原子性

- 成功时 token、delivery task、resolved_at、minted_at、minted_token_id、mint ledger 同时提交且 ledger 的 request/candidate/task/minted_at 关联精确正确；
- 在 token INSERT、task INSERT、request UPDATE、mint-ledger INSERT、提交失败五个注入点分别失败时，全部对象、ledger 与三个 request 字段均回滚；
- mint budget 只统计已提交 minted_at；
- 重试不会重复 mint、重复 task 或重复记账；
- request cleanup 与 handler 等锁的竞态不能造成已 mint 但无 request accounting。
- request retention 配置短于 mint-budget window 必须在启动/配置校验失败；在 window 内的提前 cleanup 不得删除 minted request 或让下一次请求绕过 budget；
- request-first/candidate-first cleanup 两种顺序都必须保留 immutable mint ledger + unique disposition；request 缺失时 rollback 必须从 ledger 重建 request、candidate、minted_at 与 task 的关联，缺 ledger 必须安全失败。
- intake mint 必须再次规范化已持久的 redirect_path，并证明策略收紧/历史非法值只能得到 null/安全默认跳转；不在 SUPPORTED_LOCALES 的 locale 必须从 v2 payload 整键省略，不能写 default 或 null。
- pending INSERT 必须满足现有 expires_at NOT NULL 约束但只写 epoch placeholder；验证/消费不得授权它，且 Transaction B 必须用 activation-time TTL 覆盖它。
- 真实 PostgreSQL 下，令 queue/SMTP 延迟超过 REQUEST_CODE_SEND_DEDUPE_SECONDS 后才激活 candidate；紧随的 request 仍必须因 delivered_at dedupe 保留该 active token，不得新 mint 或 supersede。

### 11.3 reservation ownership

- stale worker 不能清除新 reservation generation；
- 任意 dead 或 succeeded task 只要 reservation 非 NULL，普通 cleanup 不得取消 candidate、清空 reservation 或放开新 mint/promotion；
- reservation until 已过但 reservationId 仍有效时，promotion 仍被阻止，Transaction B 也不得仅因该时间失权；
- worker 在 SMTP 前暂停、SMTP 返回前暂停、SMTP 返回后暂停、失去 claim 后恢复的路径均有确定性测试；Transaction B 提交后、task success 前崩溃的 retry 必须只幂等成功，不得 SMTP、重新 reservation、激活或 supersede；
- confirmed socket teardown 且 exact task claim/candidate/reservation ID 匹配时，只有该 owner 可清空两列；
- SMTP 可重试失败与墙钟/AbortSignal 硬中止：必须先确认 socket closed、以 exact current claim+generation 清两列、再 failed/retry；下一个 claim 必须使用 fresh UUID 且只重发同一个 candidate；
- socket 未确认关闭、lease 已过期但无接手证明、claim/generation 清除失败时，必须保留 fence 并 terminal-safe/stuck+alert，不得把它标记为普通 retry；
- full quiescence 后 audited abandon 才可清除 terminal non-NULL fence，并有完整审计证据；
- stuck scanner 的相同 candidate/reservation generation 在节流窗口内只通知一次，窗口后才能再次通知；两个并发 scanner 对同一 generation 只能有一个获得 RETURNING 行并发送通知。
- 相同 created_at 的多个 eligible replacement 必须按 `(created_at, id)` 稳定决胜；存在更大 tuple 时旧 candidate 必须 superseded/no-op，不得激活或改动较新行；投递期旧 active 消费必须取消 candidate。

### 11.4 task claim

- 在 transactional 与 auth_delivery_v2 的同一领取组中，stale processing 必须跨 queue class 优先；
- 只有 stale 集合为空时才领取 due pending/failed；
- queue-class 隔离、每类 cap 与 shared transactional reservation 都保持；
- 同一 lease_until 或 run_after 下的 priority、id tie-break 确定；
- union/排序测试必须能抓住“due task 排到 stale task 前”的错误实现。

### 11.5 rollout、rollback 与运维

- migration 后 intake 默认关闭；
- 阶段 A 中全部新镜像强制 false、且新协议 intake 不得运行；
- 旧实例完全退出后才能 true；
- rollback drain 时 TASK_AUTH_INTAKE_MAX_PER_BATCH 不得为 0；
- terminal residue 必须可 list、count、verify-zero，且 terminal non-NULL reservation 不被普通 cleanup 删除；
- 完整 quiescence 是 audited abandon 的唯一无 owner 替代路径；
- 已 resolved request 被 retention 删除后，延迟 retry 必须正常 no-op，不得 mint、不得把该缺失无条件作为 invariant violation；
- full-quiescence abandon 在 request 已清理时必须精确验证 mint ledger、原子写入 unique abandoned disposition；缺失/不匹配 ledger 必须阻断而不是继续处置，已有相同 disposition 才可幂等 no-op；
- 旧镜像前必须按第 9.4 节精确事务 expire pending/superseded/cancelled、保持 active/consumed 不变，并验证 non-active+unconsumed+unexpired count=0；
- scripts/admin-reset.mjs、其 production dist bundle、Docker image 和管理恢复文档均覆盖同一 fence 合约。
- dead auth_intake 必须进入已去重、无敏感 payload 的告警面；告警发送失败后 periodic reconciler 必须重试且不得改写 dead 状态。

### 11.6 可观察性

- admin/member/unknown 的响应状态、响应体、响应头与 limiter 行为不可区分；
- 每组 latency 样本至少 200，source cap 对所有样本可达；
- 公开路径不触碰 request-code-email-ip；
- 告警不泄漏邮箱或角色；
- stuck alert 有 durable 节流/去重；
- 角色无关 public path 允许本地 secret 首次加载，但该加载可预热且与目标无关。

### 11.7 #176 消费期边界

- active/delivered token 的邮箱在并发晋升为 admin 后，consume transaction 必须按 token -> user 的锁顺序重新读取角色，且不得创建 session、不得改写 user、不得写 user_login 或 magic_link_consumed event；仅允许既有安全摘要 magic_link_rejected；
- 对不存在 user 行的邮箱，consume 与并发创建/提升 admin 必须复验 advisory/user 边界，不能因空行锁而绕过 admin guard；
- pending、superseded、cancelled、invalid 与 replayed token 的 verify/consume 公共结果必须保持既有无角色泄漏语义；
- Magic Link GET 确认页不得查询角色；上述消费期测试必须使用真实 PostgreSQL 并覆盖 token 已消费和 session 数量断言。

## 12. 后续实现文件范围

以下清单是 implementation PR 的最低范围；实现前必须以当时 main 复核名称与测试位置：

| 区域 | 必须覆盖的文件或类别 |
|---|---|
| Schema / migration | src/db/schema/index.ts；新的 Drizzle migration、journal、snapshot；db-reset；reservation/dead-intake alert-dedup schema；immutable mint ledger 与 delivery-disposition schema。 |
| Magic Link / SMTP transport | src/modules/auth/magic-link.ts、src/modules/mail/index.ts；真实 PostgreSQL integration tests；verify/consume/legacy-v2 compatibility tests；单次可中止 SMTP transport、AbortSignal/socket-destroy 与 wall-clock 上限 tests。 |
| Tasks | src/modules/tasks/queue-class.ts、handlers.ts、index.ts、dispatcher.ts 及对应 tests；stale-first grouped claim tests。 |
| Env / rate policy | src/lib/env.ts、env tests、rate-limit policy 及 tests；默认 intake false 与 cap minimum 1。 |
| 管理晋升 | src/modules/site/index.ts、src/modules/auth/admin-account.ts、其 tests、共享 promotion fence helper。 |
| 管理员恢复 | scripts/admin-reset.mjs、脚本 integration tests、production dist/admin-reset.mjs build contract、Dockerfile。 |
| i18n | src/modules/i18n/messages/zh.ts、src/modules/i18n/messages/en.ts、src/modules/i18n/messages/ja.ts；新增 magicLinkDeliveryInFlight 时三者必须同步。 |
| Rollback / quiescence | rollback disposition module、打包 script、production-image smoke tests、rollback/quiescence tool tests。 |
| 文档 | 相关 admin recovery、deployment、upgrade、rollback、Docker 生产 bundle 文档；Issue #176 supersession 指针；CHANGELOG。 |

明确不允许在本 Spec PR 实际修改上述任何文件。本文件也不得再把 i18n 声称为“明确不修改”。

## 13. Spec PR 与 implementation PR 门禁

### 13.1 本 Spec PR

- git diff --check 必须通过；
- 所有 Markdown code fence 必须配对；
- 不得有 trailing whitespace；
- pnpm format:check 或仓库适用的文档检查必须实际执行并报告结果；
- 完整 diff 必须由独立只读安全审查复核；
- PR 必须保持 Draft，不得关闭 Issue #184，不得标记 Ready。

### 13.2 后续 implementation PR

除第 11 节测试外，必须实际运行：

~~~text
pnpm check:request-bodies
pnpm check:auth-before-body
pnpm format:check
pnpm lint
pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build
~~~

还必须执行 migration fresh/upgrade 演练、production-image admin-reset/rollback bundle smoke test、阶段 A/B rollout 演练、rollback drain 与 full-quiescence 演练。所有证据必须绑定 implementation exact head；未执行或被基础设施阻塞的项目必须如实报告。

## 14. 明确残余

本规格不接受任何“短暂安全残余”来绕过 Issue #184。以下只是不影响核心安全保证的运行代价，必须在 implementation PR 说明：

- SMTP 不可与数据库原子提交，崩溃可能重发同一 candidate token 的邮件；
- 完整 intake/delivery 比 legacy 路径多一个 dispatcher 周期；
- non-NULL reservation 在崩溃后可能无限期阻塞 promotion，直到 exact owner 证明 socket teardown 或 full quiescence 审计处置；
- intake、request 行与审计事件带来可控写放大。

这些代价不得被表述为已接受的 admin 邮件、旧 token 复活、旧实例混部、自动删除 non-NULL reservation 或角色可区分残余。
