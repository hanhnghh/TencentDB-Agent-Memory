# TDAI 全局镜像本地部署

全局三件套镜像的本地拉起脚本 —— `memory-core` + `memory-hub` + `proxy`，可各自独立运行，也能一条命令全部启动。

## 组件与端口

| 组件 | 容器名 | 镜像（Docker Hub 公开） | 宿主机端口 | 用途 |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | 内核 gateway，记忆读写、鉴权、skill/RAG 数据面 |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | 管理面板 (Panel) + 知识服务 (Knowledge) 合并镜像 |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM 请求转发代理，coding agent 的 API 入口 |

> 三个镜像都发布在 Docker Hub 的 [`agentmemory`](https://hub.docker.com/u/agentmemory) 命名空间下，
> 多架构（`linux/amd64` + `linux/arm64`），公开可拉、无需登录。想固定版本时把 `.env` 里的 tag 从
> `:latest` 换成具体版本即可，例如 `:1.0.0-beta.1`。
>
> 腾讯内部同事也可以覆盖到内网私仓 `mirrors.tencent.com/memory-team-control/` —— 见 `.env.example` 里
> 注释掉的备选块。

## 环境要求

- macOS / Linux
- Docker（Docker Desktop / colima / OrbStack 任一）
- `bash` 4+（macOS 自带 3.2 也能跑）

## 快速开始

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# 2) 选择 PROXY_RUNTIME_MODE=proxy|hooks|both，再填写该 mode 需要的值
#    - MEMORY_LLM_* 始终供 memory-core + memory-hub 内部使用
#    - hooks 不需要 PROXY_UPSTREAM_*；proxy/both 才需要
$EDITOR .env

# 3) 干跑校验（不启动容器）
#    默认会同时校验 LLM 通路 —— 提前验证 API key/URL/模型名，避免起服务后才发现配错
./verify.sh
# 不希望发外部请求（离线环境等）：./verify.sh --skip-llm

# 4) 一键拉起三件套
./start-all.sh
```

## Runtime modes and credential boundaries

`PROXY_RUNTIME_MODE` selects one of three independently validated deployments:

| Mode | Listeners | Required proxy values |
|---|---|---|
| `proxy` (default) | public proxy on `PROXY_PORT` | URL/model plus the selected auth mode |
| `hooks` | Codex hooks on host `127.0.0.1:8097` by default (`PROXY_HOOK_PORT`) | none of `PROXY_UPSTREAM_URL`, `PROXY_UPSTREAM_MODEL`, `PROXY_UPSTREAM_API_KEY` |
| `both` | public proxy plus the separate loopback hook endpoint | same proxy requirements as `proxy` |

For `server-key`, set `PROXY_UPSTREAM_AUTH_MODE=server-key` and provide
`PROXY_UPSTREAM_API_KEY`. For existing client credential passthrough, select
`client-key` and leave `PROXY_UPSTREAM_API_KEY` empty. The generated YAML then
keeps `upstream.apiKey` empty, so each request's Authorization reaches upstream.

The credential roles do not substitute for one another:

- `MEMORY_LLM_API_KEY` is used only by the internal memory/knowledge model.
- `PROXY_UPSTREAM_API_KEY` is used only for `server-key` proxy forwarding.
- `MEMORY_HUB_USER_KEY` authorizes Codex project binding. It is not required to
  start the sidecar and must stay in protected user-level state, not project config.

`verify.sh` always validates the internal memory model. It omits the upstream
probe only in hooks-only mode; client-key mode performs an unauthenticated
reachability probe without pretending to validate a user's key. After installing
and binding the Codex plugin, run the existing doctor from `MemoryProxy`:

```bash
npm run codex -- doctor
```

Doctor reports MemoryCore reachability, binding validity, and durable outbox
health independently. The image health check selects port `8097` in hooks-only
mode and `8096` otherwise. In a container, the actual hook listener remains on
container loopback; a small signal-forwarding relay is published only as
`127.0.0.1:${PROXY_HOOK_PORT}` on the host. The named `PROXY_VOLUME` persists
the SQLite journal/outbox across container replacement.

# 一条命令：自动复制 .env → 交互式填 LLM → 自动校验通路 → 拉起三件套
./start-all.sh
```

`start-all.sh` 现在是**交互式**的，运行时会：

1. `.env` 不存在时，自动从 `.env.example` 复制一份（无需手动 `cp`）
2. 引导你填写两组 LLM（**回车 = 保留当前默认值**）：
   - `memory 组`：`BASE_URL` / `API_KEY` / `MODEL`（协议默认 `openai`）
   - `proxy 组`：先问「是否复用 memory 组配置」，复用则跳过
3. 填完**立即检查 LLM 通路是否通**，不通会提示重新输入，直到通过
4. 把填写值**写回 `.env`** 持久化（下次启动默认复用）
5. 通过后一键拉起三件套

> 想跳过交互、直接读 `.env` 也可以：手动 `cp .env.example .env` 并填好 LLM 后，
> 运行 `./start-all.sh` 一路回车确认即可（默认值就是 `.env` 里的值）。

### 干跑校验（可选）

`verify.sh` 仍可单独使用，只检查环境不启动容器：

```bash
./verify.sh              # 默认全检（含 LLM 通路预检）
./verify.sh --skip-llm   # 跳过 LLM 检查（离线环境）
```

## LLM 通路预检

`verify.sh` 默认预检内部 memory LLM；proxy/both 还会按 upstream auth mode
预检 proxy 通路（`--skip-llm` 可关闭）：

- **OpenAI 兼容协议**：`GET {base}/models`，只验证 API key + URL，**不消耗任何 token**
- **Anthropic 协议**：`POST {base}/v1/messages` 发 `max_tokens=1` 的最小消息，消耗 ≤ 10 token
- `hooks` 不探测 proxy upstream；`client-key` 只探测可达性，不发送部署 key
- **memory 组** 与 server-key **proxy 组** 独立验；若配置相同，跳过重复检查
- **容器已运行时**，额外从容器内 exec 一次 curl，验证"容器 → LLM"的网络可达性（一些企业代理/DNS 隔离环境下宿主机可达但容器不可达）

失败例子：

```
[error] memory 组 API key 无效（HTTP 401）：https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

—— API key 错、URL 错、模型名错都会在启动前拦下，不会等到 wiki ingest / chat 时才 401。

启动完成后：

- Panel UI：<http://localhost:8125/>
- Knowledge API：<http://localhost:8424/v3/>
- Knowledge Swagger：<http://localhost:8424/docs>
- Memory Gateway：<http://localhost:8420/>
- Proxy：<http://localhost:8096/>

## 独立的模型参数与用户凭据

**这是脚本设计的核心** —— memory 组和 proxy 组的 LLM 完全独立，可以指向不同供应商 / 不同模型。

### memory 组（memory-core + memory-hub 使用）

内核记忆 embed/summarize、knowledge 的 wiki ingest / 总结走这组配置。

| 变量 | 说明 | 示例 |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容 base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | 上述端点的 API Key | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | 模型 ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` 或 `anthropic`，默认 `openai` | `openai` |

### proxy 组（proxy 使用）

proxy 接到用户请求后转发到这组端点。

| 变量 | 说明 | 示例 |
|---|---|---|
| `PROXY_UPSTREAM_URL` | 转发目标 base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | server-key 转发用；client-key 必须留空 | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | 面向用户的模型 ID | `deepseek-chat` |

> 两组可以填相同值（都指向同一个 LLM），也可以完全不同：例如 memory 组用便宜模型做 embedding，proxy 组用强模型做主对话。

参数缺失时脚本会**在启动前一次性列出所有缺失项**并 `exit 1`，不会跑到一半才失败。

## 内部凭据（生产环境必看）

三件套之间可用 `MEMORY_CORE_GATEWAY_API_KEY` 认证，首次启动还会通过
`init-admin` 建一个 `system_admin` 账户。本地模板默认关闭 Gateway Bearer gate：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | 空 | memory-hub / proxy → memory-core 的可选 Bearer |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | 初始化的 system_admin 用户名 |
| `.admin-key` | 自动随机生成 | Memory Hub 登录/bind 使用的 user key 文件 |

> 空 Gateway key 只适合受信任的本地网络。公网部署前必须加网络隔离；当前 legacy
> proxy auth verifier 还不能在启用 Gateway Bearer gate 时工作，详见 `.env.example`
> 的限制说明。`.admin-key` 已随机生成，仍应按 secret 文件保护，不能提交。

## 独立使用每个组件

三个脚本可以单独执行，方便调试或只需要部分能力时：

```bash
./start-memory-core.sh       # 只跑内核 gateway（8420）
./start-memory-hub.sh   # 只跑面板 + 知识（8125 + 8424）；需要 MEMORY_LLM_* 参数
./start-proxy.sh        # 按 PROXY_RUNTIME_MODE 启动；hooks 不需要 PROXY_UPSTREAM_*
```

依赖关系：

- **memory-core**：无外部依赖，可以独立起
- **memory-hub**：能独立启动（LLM_MODE=custom 直连 LLM），但内部 knowledge 调 memory-core 做 RAG 时会失败 → 建议 memory-core 先起
- **proxy**：能独立启动（cost-guard 不可用时自动降级 passthrough，直接转发），但 auth / tdai memory / skill 注入需要 memory-core 才有效

任意组件缺失时脚本会 `warn` 提醒但不阻塞。

## 数据持久化

- `tdai-memory-core-data`（named volume）→ memory-core 的 SQLite / 记忆数据
- `tdai-panel-data`（named volume）→ memory-hub 里 knowledge 的 SQLite / git clone / wiki 文件
- `tdai-memory-proxy-data`（named volume）→ proxy SQLite + durable outbox

`docker volume rm` 之前数据一直保留。卷名可通过 `MEMORY_CORE_VOLUME`、
`PANEL_VOLUME` 和 `PROXY_VOLUME` 分别修改。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume（下次启动数据还在）
./stop-all.sh --purge    # 停容器 + 删 volume + 删网络（彻底清理）
```

## 查看日志

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub 内部有两个进程（panel + knowledge），日志分别在容器内 `/data/knowledge/logs/panel.log` 和 `.../knowledge.log`。

## 端口冲突

如果 `8125` / `8420` / `8424` / `8096` / `8097` 与本地已有服务冲突，直接在 `.env` 改：

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
PROXY_HOOK_PORT=18097
# knowledge 对外可达地址要跟着 KNOWLEDGE_PORT 走
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## 使用 proxy 作为 coding agent 的 API base

以 Claude Code 为例：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# 使用 openai 协议的客户端类似：OPENAI_BASE_URL=http://localhost:8096/v1
```

Panel UI "客户端接入地址" 卡片会自动拼上宿主机的 LAN IP + `PROXY_PORT`（例如
`http://192.168.1.100:8096/codebuddy/default`），别人的电脑复制过去就能直接连过来。
由 `MEMORY_HUB_PROXY_PUBLIC_URL`（未设时脚本用 `hostname -I` / macOS `ipconfig getifaddr en0`
自动探测，探不到才回落 `localhost`）注入到 memory-hub 里的 `metadata-instances.json.proxy_endpoint`。
Panel 后端 → Kernel 的转发不受此变量影响（始终走 `REMOTE_INSTANCE_URL` → memory-core:8420）。
自动探测的地址不对时（多网卡 / 公网域名 / 反代前置），在 `.env` 显式设
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<真值>:8096`。想让 UI 卡片走老行为（回落到
gateway_endpoint）就把 `MEMORY_HUB_PROXY_PUBLIC_URL` 显式设为空字符串。

`proxy` 默认关闭 `auth` / `sessionInit` / `costGuard`（这些依赖内部服务），只做纯转发 + `tdai-memory` 上下文注入（injector 名称，非容器名）。要开启完整流水线，需要另行配置 —— 参见 `context_proxy/config.example.yaml`。

## 常见问题

**Q: `./start-all.sh` 卡在 wait_healthy？**
镜像可能还在拉取。用 `docker pull <IMAGE>` 手动预拉一次再跑脚本。

**Q: memory-hub 起来但 Panel 打不开？**

检查 `.env` 里 `KNOWLEDGE_PUBLIC_BASE_URL` 是不是含 `/v3` —— 缺 `/v3` panel 会报错。

**Q: proxy 转发返回 401？**
server-key 下检查 `PROXY_UPSTREAM_API_KEY`；client-key 下检查客户端请求携带的
Authorization。两种模式都应确认 `PROXY_UPSTREAM_URL`，并查看 `docker logs tdai-proxy`。

**Q: 如何在容器外访问宿主机上其它服务（Ollama、Langfuse 等）？**
脚本已默认 `--add-host=host.docker.internal:host-gateway`。容器内用 `http://host.docker.internal:<port>` 即可。
