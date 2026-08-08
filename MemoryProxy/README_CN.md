# MemoryProxy

MemoryProxy 是一个**透明的 LLM 请求代理**：把编码 Agent（Claude Code / CodeBuddy 等）原本直连大模型的请求，改为先经过它中转。它在转发前后自动完成会话初始化、记忆注入、对话回流等动作，让 Agent **无需改动一行代码**就能用上 [MemoryCore](../MemoryCore/README_CN.md) 提供的团队记忆、Skill 和 Knowledge。

对客户端和上游模型来说，它是“透明”的——不改变任何协议，原样转发 OpenAI `/v1/chat/completions` 和 Anthropic `/v1/messages`，只是在中转的这一进一出里，顺手做了这些事：**会话初始化、上下文注入、对话回流、鉴权与用量上报**。

> 一句话分工：MemoryProxy 管“接入与转发”，MemoryCore 管“记忆的存储与处理”。Proxy 自身不落记忆数据，所有 Memory / Skill / Knowledge 读写都经 MemoryCore Gateway（默认 `:8420`）完成。整体产品定位见仓库根 [README_CN.md](../README_CN.md)。

## 它在整个体系里的位置

```text
编码 Agent (Claude Code / CodeBuddy / ...)
        │  OpenAI / Anthropic 协议（不改动）
        ▼
   MemoryProxy :8096        ← 本项目（LLM 请求代理）
        │  会话初始化 / 注入 / 回流 / 鉴权 / 上报
        ├─────────────► 上游 LLM（TokenHub / OpenAI-compatible）
        │
        └─ HTTP API ─► MemoryCore Gateway :8420
                        ├─ Memory  L0 / L1 / L2 / L3
                        ├─ Skill   检索 / 归档 / 抽取
                        └─ Meta    Team / Agent / Task / Knowledge
```

## 核心能力

- **会话初始化**：首次对话时拦截请求，通过交互式表单引导用户选择 team → agent → task，完成后把 agent/task 上下文注入 system prompt。支持从请求头（`x-team-id` / `x-agent-id` / `x-task-id`）自动预选。
- **上下文注入**：把 Skill、Knowledge、Memory L2/L3 等按需注入 system prompt；L0/L1 通过只读工具接口暴露给模型主动查询，避免破坏上游 KV cache。
- **对话回流（提取）**：每轮真人对话结束时，把对话切片同步发到 MemoryCore `/v3/skill/conversation/add`（Skill 归档）并写入 L0 短期记忆，供 core 侧后台抽取。
- **鉴权与身份**：调用 MemoryCore `POST /v3/meta/auth/verify` 校验 `x-tdai-user-key`，解析出 `user_id` 作为全链路用户标识；`spaceId`（memory 实例 id）从 `/proxy/<spaceId>/...` 路径自动提取。
- **系统用户短路透传**：内部服务账号（如 memory / wiki 内部调用）命中后跳过 session init 和注入，只做透明转发 + 计费。
- **Skill Bridge / Memory Bridge**：反向代理 MemoryCore 的 skill / memory HTTP 工具，转发时注入 `serviceToken`，避免凭据出现在 LLM 可见的 prompt 中。
- **统一存储抽象（ProxyStorage）**：会话初始化状态、注入缓存与 Skill 状态（`inj:*` / `sk:*` / `vpin:*`）支持 Redis、COS（kernel-sts）、SQLite、FS、Memory 五种后端，多节点部署首选 COS。
- **Input TPM / QPM 限流**：按 `spaceId × 最终模型` 在 Redis 上做 60 秒滑动窗口限流，可通过 `/v3/admin/rate-limits` 动态调整。
- **可观测与用量上报**：Opik trace、Langfuse（一个 trace = 一个 turn）、ClickHouse（按 turn 记录 token 明细）三路互相独立，任一失败不影响业务。
- **Credit 计费上报**：每次上游响应完成后按定价表计算 CreditDelta 上报到计费服务；仅识别路径带 `/proxy/<spaceId>/` 的请求。
- **多节点部署**：结合外部 gateway 与 COS 后端支持多实例水平扩展；`/skill-bridge` 与 `/memory-bridge` 前缀由 gateway 原样透传到 proxy 实例。

## 请求处理流程

一次带 `spaceId` 的主模型调用大致经过以下阶段：

```text
POST /proxy/<spaceId>/v1/chat/completions | /v1/messages
   │
   ├─ 1. auth ─────── 校验 x-tdai-user-key，解析出 user_id
   ├─ 2. systemUser ─ 命中内部账号则短路透传
   ├─ 3. sessionInit ─ 首次对话弹表单：team → agent → task
   ├─ 4. injection ── system prompt 注入 skill / knowledge / memory
   ├─ 5. rateLimit ── spaceId × 最终模型 TPM/QPM 限流
   ├─ 6. forward ──── 转发到上游 LLM
   ├─ 7. extract ──── 一轮结束后异步回流 conversation + L0
   └─ 8. report ───── ClickHouse / Langfuse / Opik / Credit 上报
```

## 记忆层与注入策略

MemoryProxy 对齐 MemoryCore 的四层记忆结构，按“注入 + 工具化”两种方式接入 prompt：

| 层级 | 作用 | 接入方式 |
| --- | --- | --- |
| L0 | 短期对话记忆 | 每轮对话由 proxy 主动写回 MemoryCore |
| L1 | 会话级关键记忆 | 通过 `<tdai_memory_tools>` 工具让模型按需召回 |
| L2 | Agent Profile | 直接注入 system prompt |
| L3 | Team / Global 记忆 | 直接注入 system prompt |

Skill 与 Knowledge 沿用同样的思路：

- `<cloud_skills>` —— 从 MemoryCore RAG 检索到的相关 Skill 摘要
- `<skill_tools>` —— 告诉模型如何通过 curl 调用 Skill 的说明块（读写权限由 `skillRuntime.allowLlmWrite` 控制）
- `<knowledge_tools>` —— 团队知识资源（Wiki / CodeGraph）两步自发现工具
- `<session_context>` —— session init 完成后每轮追加的 agent/task 信息

## 环境要求

- Node.js `v22.x`（启动时强校验；推荐 `>= 22.16.0`）
- npm 或 pnpm
- 一个已运行的 **MemoryCore Gateway**（默认 `:8420`），提供 Auth / Skill / Meta / Memory API
- Redis（默认承载会话/注入/Skill 状态；启用 `storage.enabled=true` 后可切换到其他后端）
- 一个 OpenAI-compatible 上游 LLM API（TokenHub 或其他）

## 快速开始

### 安装、信任并诊断 Codex 集成

在 `MemoryProxy` 目录安装依赖，然后注册已打包的本地 marketplace/plugin：

```bash
npm install
export MEMORY_CORE_ENDPOINT=http://127.0.0.1:8420
export MEMORY_CORE_SERVICE_TOKEN=service-token-from-deployment-config
npm run codex -- install --config config.yaml
```

安装命令使用参数数组，因此仓库或安装包路径可以包含空格。它会在
`$XDG_CONFIG_HOME/tencentdb-agent-memory/codex/plugin-data/data`（或
`~/.config/tencentdb-agent-memory/codex/plugin-data/data`）创建受保护的 sidecar 可写状态，
绝不会把运行时状态写入不可变的 plugin 包。安装会输出 `hooks.json` 的准确
SHA-256，并明确显示 hooks 为 **NOT TRUSTED**，同时启动受管理的 hooks-only
sidecar。Service token 仅从环境继承，不会写入项目、安装状态、进程参数或诊断输出。

打开 Codex，用 `/hooks` 审查已安装的定义，然后记录安装命令输出的准确摘要：

```bash
npm run codex -- trust --hooks-sha <reviewed-sha256>
```

Install 与 upgrade 会管理 sidecar 生命周期。如需前台调试，请先停止受管理的安装，
再手动运行下列命令；它会强制使用 `hooks` 模式，并把 proxy 数据库与 durable
outbox 都放到受保护的数据目录：

```bash
npm run codex -- sidecar --config config.yaml
```

按下文绑定项目后，运行完整诊断：

```bash
npm run codex -- doctor
```

Doctor 会分别报告 `plugin_installed`、`plugin_enabled`、`hooks_trusted`、
`sidecar_reachable`、`project_binding`、`binding_valid`、`memory_core_reachable` 与
`outbox_healthy`，且不会打印已保存的 key 或 service token。升级必须显式执行；
若 `hooks.json` 已变化，摘要会失配，trust 会重新失败，直到用户审查新定义：

```bash
npm run codex -- upgrade
```

Uninstall 会先排空并停止受管理的 sidecar，再移除 Codex plugin，从而停止新的 lifecycle hook 投递。Durable sidecar
数据默认保留，并会打印保留路径。只有确定要删除该数据库时才使用
`--purge-data`；项目 binding 与受保护凭据会继续保留，直到运行 `unbind`（可选
`unbind --forget-credential`）。

```bash
npm run codex -- uninstall
# 或永久删除本地 durable 数据库：
npm run codex -- uninstall --purge-data
```

### Codex 项目绑定

Codex 使用项目本地、且不含密钥的 Team/Agent/Task 绑定。`bind` 命令会先验证
用户密钥，并通过 MemoryCore metadata API 确认当前用户能够访问这三个 ID，
全部验证成功后才会写入文件。当前运行时契约要求必须绑定 Task。

```bash
export MEMORY_CORE_ENDPOINT=http://127.0.0.1:8420
export MEMORY_CORE_SERVICE_TOKEN=service-token-from-deployment-config
export MEMORY_HUB_USER_KEY=your-memory-hub-user-key

npm run codex -- bind \
  --service-id mem-example001 \
  --team-id team-id \
  --agent-id agent-id \
  --task-id task-id

npm run codex -- binding-status
npm run codex -- doctor
npm run codex -- unbind
```

项目配置位于 `.codex/memory-binding.json`，只包含绑定 ID 和偏好设置等非敏感
信息。Memory Hub 用户密钥单独存放在用户配置目录
（`$XDG_CONFIG_HOME/tencentdb-agent-memory/codex`，或
`~/.config/tencentdb-agent-memory/codex`）中；目录权限为 `0700`，文件权限为
`0600`。如果凭据目录位于已绑定项目内，命令会拒绝使用。密钥只通过环境变量
接收，不接受命令行参数，避免泄露到 shell 历史或进程参数。使用
`unbind --forget-credential` 还会删除该 Memory 服务对应的用户密钥。
`binding-status` 与 `unbind` 是本地操作；`doctor` 会向 MemoryCore 重新验证已保存
的 ID，但不会调用模型。

这些凭据的用途彼此独立：`MEMORY_HUB_USER_KEY` 用于授权用户绑定，
`MEMORY_CORE_SERVICE_TOKEN` 用于本地集成向 MemoryCore 鉴权。两者都不是代理
模型凭据（`PROXY_UPSTREAM_API_KEY` 或 `upstream.apiKey`），也不是内部记忆提炼
模型凭据（`MEMORY_LLM_API_KEY`）。

### Codex 生命周期上下文

仓库内插件骨架位于 `plugins/tencentdb-agent-memory`。其中唯一的轻量可执行程序
会把官方 `SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` 和
`SessionEnd` JSON payload 发送到仅监听回环地址的 hook sidecar；Codex 仍然通过
自己的订阅通道调用模型。

无需配置 proxy 上游凭据即可启动 sidecar：

```bash
npm start -- --config config.yaml --mode hooks
```

`SessionStart` 支持 `startup`、`resume`、`clear` 和 `compact`，按顺序恢复 session、
memory、skill 与 knowledge 上下文。返回内容带明确分隔和 `capture=exclude` 标记，
会脱敏 secret，并在输出上限内按确定性顺序选择完整 block。官方 payload 中的
`transcript_path` 会被接受，但此路径不会读取它，也不会把 transcript 当作主协议。

`UserPromptSubmit` 只有在把准确的 `(service, team, user, agent, task, source,
session, turn, prompt)` 身份持久写入 SQLite journal 后才确认成功。可在
`.codex/memory-binding.json` 中加入
以下非敏感偏好，启用逐 prompt 的 L1 recall 并限制返回 block 数：

```json
{
  "preferences": {
    "dynamicRecall": true,
    "contextLimit": 5
  }
}
```

hook 不会替换或改写原 prompt。sidecar 不可用时，context 读取会返回合法的空 hook
输出，Codex 会在没有注入 memory 的情况下继续。

`PostToolUse` 会在确认前把官方 payload 中的 tool name、tool-use ID、input、response
和失败 shell outcome 写入 journal，覆盖可观察的本地 shell/exec、`apply_patch` 与
MCP 路径。`Stop` 先持久化最终 assistant message，再通过 durable outbox 入队唯一的
L0 user/assistant pair 和完整、含工具信息的 normalized skill round。稳定的
session/turn/source identity 保证重复 tool event、重复 `Stop` 以及 sidecar 重启后的
replay 都是幂等的。`SessionEnd` 仅用于通知，绝不是 round 的必需 commit point。

成功执行 `SessionStart` 后，prepared context 只会声明已为当前绑定资产启用的能力。
Codex 随后可通过 loopback sidecar 执行只读 memory 检索、可见的 skill 操作，以及
已授权的 Wiki/CodeGraph 工具。Sidecar 会解析已初始化的 Codex session，覆盖调用方
伪造的身份字段，执行 MemoryRuntime capability 与 Team/Agent/Task ACL 判断，并且只
转发 allowlist 内的操作。这些 bridge 路由不会落入 public proxy catch-all。

Hooks 模式还提供无需模型参与的管理命令。请显式指定当前 Codex session（或导出
`CODEX_SESSION_ID`）。Sidecar 默认地址为 `http://127.0.0.1:8097`；只能通过
`--sidecar-url` 或 `CODEX_MEMORY_SIDECAR_URL` 改为另一个 loopback HTTP 地址。

```bash
npm run codex -- mem-help
npm run codex -- sync --session-id "$CODEX_SESSION_ID"
npm run codex -- refresh --session-id "$CODEX_SESSION_ID"  # sync 的别名
npm run codex -- force-archive --session-id "$CODEX_SESSION_ID" --reason "capture workflow"
npm run codex -- create-skill --session-id "$CODEX_SESSION_ID" \
  --name migration-checklist --content-file ./SKILL.md
```

`create-skill` 仍受已配置的 skill 写入开关约束。`mem:*` 请求拦截仍然只属于 proxy
模式；这些 CLI 是 hooks 模式下的显式等价操作，绝不会替换 assistant response。

Codex 并不会为所有 hosted 或特殊工具暴露 `PostToolUse`。这些事件会明确缺失；集成
不会从 `transcript_path` 推断它们，也不会对不支持的路径声称精确的 tool visibility。
若 sidecar 在 `UserPromptSubmit`、`PostToolUse` 或 `Stop` 期间不可用，可执行程序会
失败退出，而不会确认尚未持久化的写入。上述安装流程绝不会把“plugin 已安装”
当作“hook 已信任”；依赖 lifecycle capture 前，必须用 `/hooks` 审查生效定义并记录
其准确摘要。

### 1. 安装依赖

```bash
cd MemoryProxy
npm install
```

### 2. 创建配置

基于示例配置创建自己的 `config.yaml`：

```bash
cp config.example.yaml config.yaml
# 按需修改 upstream / auth / tdai / skill / storage 等段
```

至少需要确认这几项：

- `runtime.mode` —— `proxy`（默认）、`hooks` 或 `both`
- `upstream.url` / `upstream.apiKey` —— 上游 LLM 地址与凭据（`hooks` 模式不需要）
- `auth.url` / `tdai.endpoint` / `skill.endpoint` —— 指向你的 MemoryCore Gateway（默认 `http://127.0.0.1:8420`）

> **本地无 Redis 快速跑通**：示例配置默认 `redis.enabled: true`，本机没起 Redis 时会持续刷 `ECONNREFUSED 127.0.0.1:6379`。纯本地开发建议改为 `redis.enabled: false` + `storage.enabled: true`（`storage.backend: sqlite`），会话/注入/Skill 状态改走本地 SQLite，启动即干净。

### 3. 启动服务

```bash
npm run start:config
# 等价于：
node --import tsx/esm src/index.ts --config config.yaml
```

使用 `--mode hooks` 只启动 loopback hook sidecar；使用 `--mode both` 在同一进程中
启动 public proxy 与本地 hook 两个 listener。Hook listener 默认监听
`127.0.0.1:8097`，在 `runtime.hooks` 下配置，并拒绝非 loopback 地址。

### 4. 健康检查

```bash
curl http://127.0.0.1:8096/health
```

返回示例（`storage.effective` 是存储后端的观测锚点）：

```json
{
  "status": "ok",
  "version": "0.2.0",
  "mode": "both",
  "upstream": "configured",
  "listeners": {
    "proxy": { "enabled": true, "ready": true, "host": "0.0.0.0", "port": 8096 },
    "hooks": { "enabled": true, "ready": true, "host": "127.0.0.1", "port": 8097 }
  },
  "storage": { "enabled": false, "requested": "sqlite", "effective": "sqlite", "degraded": false }
}
```

## 启动方式

```bash
# 直接启动（使用内置默认值，不推荐生产）
npm start

# 指定配置文件
npm run start:config

# CLI 参数覆盖（优先级最高）
node --import tsx/esm src/index.ts --port 9000 --upstream https://other.api/v1

# 开发模式（文件变更自动重启）
npm run dev:config
```

### 后台管理脚本 `proxy.sh`

固定使用 `./config.yaml`，自动查找 `node` 路径（兼容 nvm / fnm），日志按日期写入 `logs/YYYY-MM-DD.log`。

```bash
./proxy.sh start          # 后台启动
./proxy.sh stop           # 停止
./proxy.sh restart        # 重启
./proxy.sh status         # 查看运行状态（含 /health 输出）
./proxy.sh log            # tail 今日日志

./proxy.sh daemon         # 守护进程模式（崩溃自动拉起）
./proxy.sh daemon-stop
./proxy.sh daemon-status
```

## 客户端配置

把编码 Agent 的上游地址指向本代理，其余字段（`apiKey`、`model` 等）保持不变。请求路径推荐带上 `spaceId`（memory 实例 id），proxy 会自动提取用于鉴权、注入与计费。

OpenAI 兼容客户端：

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/chat/completions"
}
```

Anthropic Messages 客户端：

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/messages"
}
```

## 主要 HTTP 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/proxy/<spaceId>/v1/chat/completions` | OpenAI 兼容主模型调用（带 memory 实例 id） |
| `POST` | `/proxy/<spaceId>/v1/messages` | Anthropic Messages 主模型调用 |
| `POST` | `/v1/messages` | Anthropic Messages API（无 spaceId 兜底） |
| `POST` | `/*` | OpenAI 兼容聊天接口（catch-all） |
| `ALL`  | `/skill-bridge/**` | 反向代理 MemoryCore skill HTTP 工具 |
| `ALL`  | `/memory-bridge/**` | 反向代理 MemoryCore memory HTTP 工具 |
| `POST` | `/v3/instance/proxy-destroy` | 运维口：实例销毁时清 COS 缓存 |
| `GET/PUT/DELETE` | `/v3/admin/rate-limits` | 查询 / 修改实例 × 模型 TPM/QPM |
| `GET`  | `/health` | 运行时健康检查（含 `storage.effective`） |
| `GET`  | `/whoami` | API Key → keyId（纯文本，便于 curl） |

## 配置说明

完整带注释的示例见 [`config.example.yaml`](./config.example.yaml)。配置优先级：**CLI 参数 > YAML 配置文件 > 内置默认值**。

各配置段速览：

| 段 | 作用 |
| --- | --- |
| `runtime` | 进程模式（`proxy` / `hooks` / `both`）与 loopback hook listener |
| `server` | 监听 host / port、上游转发超时 |
| `upstream` | 默认上游 URL 与全局 `apiKey`（非空则替换转发请求鉴权） |
| `log` | 日志目录、级别、后端与轮转策略 |
| `redis` | 会话 / 注入 / Skill 状态默认后端；不启用 `storage.enabled` 时使用 |
| `storage` | 统一存储抽象（`cos` / `sqlite` / `fs` / `memory`），多节点部署首选 `cos` |
| `auth` | `x-tdai-user-key` → `user_id` 校验（调用 MemoryCore `/v3/meta/auth/verify`） |
| `admin` | 运维端点（如 `/v3/instance/proxy-destroy`）的 shared secret |
| `systemUsers` | 内部服务账号，命中后短路透传 |
| `injection` | 上下文注入总开关与 injector 列表（`skill` / `knowledge` / `tdai-memory`） |
| `extraction` | 对话回流总开关（skill 归档 + L0 写入） |
| `sessionInit` | 会话初始化表单流程、header 自动预选策略 |
| `tdai` | MemoryCore 连接与 L0/L1/L2/L3 开关 |
| `skill` | MemoryCore 数据面配置（Skill RAG、Skill 归档、Meta） |
| `knowledge` | 独立的 knowledge gateway（可与 skill 不同） |
| `skillRuntime` | 是否允许主模型写 Skill（默认只读） |
| `rateLimit` | Memory 实例 × 实际模型的 Input TPM / QPM 限流 |
| `clickhouse` | 按 turn 的用量上报（计费数据源） |
| `creditReport` / `creditPricing` | Credit 计费上报与定价表 |
| `upstream.agents` | 按 agent name 覆盖上游 URL + apiKey（如 `claude-code` 单独走 CCR） |

> `injection`、`extraction`、`sessionInit`、`tdai`、`skill`、`knowledge`、`skillRuntime` 是与“记忆”直接相关的配置段，接入时优先关注它们。

### 常用环境变量

```bash
TDAI_MEMORY_SYSTEM_USER_ID   # memory 内部服务账号 user_id
TDAI_MEMORY_SYSTEM_USER_KEY  # memory 内部服务账号 apiKey（仅供运维查看）
TDAI_PROXY_ADMIN_API_KEY     # 运维端点鉴权 shared secret
PROXY_DB_PATH                # sqlite 后端 db 路径（storage.sqlite.dbPath 未配时使用）
```

## 存储后端选型

`storage.enabled=true` 后所有会话/注入/Skill 状态（`inj:*` / `sk:*` / `vpin:*`）走 ProxyStorage：

| 后端 | 适用场景 | 说明 |
| --- | --- | --- |
| `cos` | 生产多实例部署 | 跨节点共享；仅支持 kernel-sts（每 spaceId 一份临时凭证） |
| `sqlite` | 单实例本地开发 / CI | 内置 sweeper 定时清 `ttl/` 桶；`nottl/` 桶永久保留 |
| `fs` | 离线 / docker 兜底 | 无 sweeper，交给外部 tmpwatch |
| `memory` | 兜底 / 测试 | 进程重启即清 |

Key 布局统一为 `proxy_cache/{ttl|nottl}/{spaceId}/{userId}/{agentSource}/{sessionId}/...`；`ttl/` 只放热缓存（可重建），`nottl/` 放 binding 等必须持久化的业务态。

降级链：`cos → sqlite → fs → memory`。任一后端 init 失败自动降级，`/health` 端点会暴露 `storage.effective` 作为观测锚点。

## Docker

镜像用 tsx 直接运行 TypeScript，以 `tini` 作 PID 1、非 root 用户运行，内置 `/health` 的 `HEALTHCHECK`。多阶段构建需启用 BuildKit。

在 `MemoryProxy/` 目录构建：

```bash
DOCKER_BUILDKIT=1 docker build -t memory-proxy:local .
```

启动容器（配置文件通过挂载 `/data/config.yaml` 提供；sqlite 存储持久化到 `/data/tdai-memory-proxy`）：

```bash
docker run --rm \
  -p 8096:8096 \
  -v "$PWD/config.yaml:/data/config.yaml:ro" \
  -v tdai-proxy-data:/data/tdai-memory-proxy \
  -e TDAI_PROXY_ADMIN_API_KEY="replace-with-a-strong-random-token" \
  memory-proxy:local
```

- 配置文件默认路径 `/data/config.yaml`，可在 `docker run` 末尾追加 `--config /other/path.yaml` 覆盖。
- 通过环境变量或 Secret Manager 注入凭证，不要把 API Key / STS 凭证写入镜像和配置仓库。
- 健康检查：`docker inspect --format '{{.State.Health.Status}}' <container>`。

## 目录结构

```text
MemoryProxy/
  src/
    index.ts / server.ts              入口与 HTTP 路由
    handler.ts / anthropicHandler.ts  OpenAI / Anthropic 请求处理器
    auth.ts / identity.ts             用户身份与鉴权
    systemUser.ts / systemUserPassthrough.ts  内部账号短路透传
    session/                          会话初始化：表单流程、状态存储、Claude Code / CodeBuddy 适配
    injection/                        注入 pipeline：skill / knowledge / tdai-memory 等 injector
    skill/                            Skill Bridge、conversation/add 归档触发、版本 pin
    memory/                           Memory Bridge 反向代理
    knowledge/ / meta/                MemoryCore knowledge / metadata 客户端
    tdai/                             Memory L0/L1/L2/L3 客户端、pending write 队列
    storage/                          ProxyStorage 抽象（cos / sqlite / fs / memory）
    db/                               会话 / 注入 / Skill 状态持久化 Repo
    rate-limit/                       Input TPM / QPM 限流
    routes/                           管理端点（admin-auth / instance-destroy / rate-limits）
    clickhouse.ts / langfuse.ts / opik.ts  三路可观测上报
    credit-reporter.ts / pricing.ts   Credit 计费上报与定价
    report/ / logger.ts               结构化日志系统与 JSONL 用量日志
  gateway/                            可选负载均衡网关（keyId 一致性 hash）
  docs/                               架构、设计文档与 e2e runbook
  scripts/                            冒烟、迁移、维护脚本
  config.example.yaml                 带注释的完整配置示例
  Dockerfile                          MemoryProxy 镜像
  proxy.sh                            后台启动 / 守护脚本
  package.json
```

## 运行测试

```bash
npm test              # vitest run（默认单元 + 集成）
npm run test:watch
```

`__tests__/` 分布在各子模块下：`session/__tests__`（会话流程）、`skill/__tests__`（归档触发、版本 pin）、`storage/__tests__`（各后端契约）、`db/__tests__`（Repo 一致性）等。`docs/` 还提供多份端到端 runbook（`e2e-runbook.md` / `e2e-full-coverage-runbook.md` 等），用于在真实 MemoryCore + Redis + Storage 后端上验证记忆链路。

## 安全与发布注意事项

- 非回环地址监听或多节点部署时，必须启用 `auth.enabled=true`，并通过 env 注入 `TDAI_PROXY_ADMIN_API_KEY` 保护运维口。
- 所有 Secret 通过环境变量或 Secret Manager 注入；不要把真实 `apiKey` / `serviceToken` / STS 凭证 / 计费 URL 提交进配置仓库。
- 部署到多节点时必须使用 `storage.backend=cos` 并显式配置 `injection.externalGatewayUrl`，否则每个实例各自缓存会导致上游 KV cache miss。
- 不要提交生成数据、本地数据库、日志或环境变量文件（`logs/`、`*.db`、`.env`、`dump.rdb`、`session*.json`、`*.pid` 等）。

## License

MIT
