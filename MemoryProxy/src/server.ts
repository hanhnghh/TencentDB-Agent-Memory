/** Hono app factory — registers all routes. */

import { Hono } from "hono";
import { handleChatCompletions } from "./handler.js";
import { handleAnthropicMessages } from "./anthropicHandler.js";
import { handleAuxiliaryEndpoint } from "./auxiliaryHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { hasCostGuardMarker } from "./routes/whitelist.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import type { ProxyConfig } from "./types.js";
import type {
  MemoryRuntimeProvider,
} from "./runtime/production.js";
import { RuntimeHealth, runtimeHealthStatusCode } from "./runtime/health.js";

export interface CreateAppOptions {
  memoryRuntimeProvider?: MemoryRuntimeProvider;
  runtimeHealth?: RuntimeHealth;
  storesActivated?: boolean;
}

export function createApp(config: ProxyConfig, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const memoryRuntimeProvider = options.memoryRuntimeProvider;
  const runtimeHealth = options.runtimeHealth ?? new RuntimeHealth(
    config,
    memoryRuntimeProvider,
    { trackConnectivity: false },
  );
  if (!options.runtimeHealth) {
    runtimeHealth.markListenerReady("proxy", config.server.host, config.server.port);
  }
  const handleOpenAI = (c: Parameters<typeof handleChatCompletions>[0]) =>
    handleChatCompletions(c, config, memoryRuntimeProvider);
  const handleAnthropic = (c: Parameters<typeof handleAnthropicMessages>[0]) =>
    handleAnthropicMessages(c, config, memoryRuntimeProvider);

  // Hook lifecycle traffic belongs exclusively to the loopback listener.
  // Decode before matching so encoded separators cannot bypass the public
  // namespace reservation and fall through to the LLM forwarding catch-all.
  app.use("*", async (c, next) => {
    const classification = classifyPublicPath(c.req.path);
    if (classification === "local_sidecar") {
      return c.json({ error: "not_found" }, 404);
    }
    if (classification === "malformed") {
      return c.json({ error: "invalid_path" }, 400);
    }
    await next();
  });

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!options.storesActivated && !tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // `/cost-guard` marker 门控 (P0 前置)：
  // markerOptIn=false 时 marker 完全作废——任何路径里带 `/cost-guard/` 段的请求
  // 都直接 404，避免 catch-all `POST /*` 把它兜住走成默认路由（会产生迷惑：
  // 客户端以为自己"启用了 marker"，proxy 却按 default_passthrough 处理）。
  // 放在最前面，早于所有业务路由。
  if (!config.costGuard.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasCostGuardMarker(c.req.path)) {
        return c.json(
          {
            error: "cost_guard_marker_disabled",
            message:
              "The /cost-guard URL marker is disabled on this deployment. " +
              "Remove the /cost-guard segment from the path, or set costGuard.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // Health check
  //
  // 多节点场景：storage 请求 cos 但降级到进程内 (fs / memory / sqlite) 时
  // 返回 503 + degraded=true，让 k8s LB 把该 pod 摘掉，避免"两个节点各写各
  // 的内存"这种数据一致性事故。sqlite 也算 process-local——多节点各自本地
  // 文件也是不共享的。见 docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2。
  app.get("/health", async (c) => {
    const body = await runtimeHealth.snapshot();
    return c.json(body, runtimeHealthStatusCode(body));
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: 同样模式但反代 tdai L0/L1/L2/L3 只读接口。
  // 让 LLM 用 Bash 调 <proxy>/memory-bridge/v3/atomic/search 等，proxy 注入身份。
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // ── Ops endpoint（在 catch-all `POST /*` 之前注册） ───────────────────────
  // /v3/instance/proxy-destroy — shark 销毁实例时清理 proxy 侧 COS 缓存 +
  // kernel-sts pool。契约字段跟 core `/v3/instance/destroy` 对齐，路径用
  // `proxy-destroy` 动作与 core 区分。鉴权走 config.admin.apiKey（空则公开）。
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  // ── Session management endpoints (mem: command 底层接口, 面板前端可复用) ──
  app.post("/v3/session/refresh-cache", (c) => {
    return import("./routes/session-refresh.js").then(({ createSessionRefreshHandler }) =>
      createSessionRefreshHandler(config)(c),
    );
  });
  app.post("/v3/session/force-archive-skill", (c) => {
    return import("./routes/session-force-archive.js").then(({ createSessionForceArchiveHandler }) =>
      createSessionForceArchiveHandler(config)(c),
    );
  });

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  // Anthropic Messages API
  app.post("/v1/messages", handleAnthropic);

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // 这些端点走轻量透传 handler（不进入路由模块，不构成对话回合）。
  // 详见 docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId — 客户端标准配置格式：
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // 路径示例: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  // `/cost-guard` marker: primary handler 检测到该段后启用 cost-guard 路由；
  // 默认路径（不带 marker）则跳过 router 直接透传上游。
  //
  // marker 机制受 `config.costGuard.markerOptIn` 门控：
  //   - false（默认/线上）: 不注册这两条路由——所有请求走 `/:agent/:spaceId/v1/...`，
  //     handler 内 useGuard 恒 true，行为等同于历史"默认走 router"。此时任何
  //     `/cost-guard/...` 请求都命中不到路由，走到最终 catch-all 或返 404
  //     （catch-all `/*` 存在，会 fallthrough 到 handleChatCompletions；下面在
  //     顶部加了 marker→404 拒绝，见 handler / anthropicHandler）。
  //   - true（测试环境）: 注册以下两条 marker 路由；handler 内根据 marker 决定
  //     是否走 router。
  // 详见 `hasCostGuardMarker`。
  // Hono 优先匹配更精确的路径，需注册在通用 `/:agent/:spaceId/v1/...` 之前。
  if (config.costGuard.markerOptIn) {
    app.post("/:agent/:spaceId/cost-guard/v1/messages", handleAnthropic);
    app.post("/:agent/:spaceId/cost-guard/v1/chat/completions", handleOpenAI);
  }

  // `/analyse` marker (asset-reflection 内部效果评估) —— 跟 cost-guard 完全对称：
  // 由 `injection.assetReflection.markerOptIn` 门控。marker 只是一个透明标记，
  // handler 内 (AssetReflectionInjector) 检测到即在 system prompt 末尾追加
  // <asset_reflection>；不带 marker 的请求走原有正常路由。
  //
  // ⚠️ 关键：不注册这两条路由时，`/{agent}/{spaceId}/analyse/v1/messages`
  // (5 段) 会 fall through 到最下面的 catch-all `POST /*` → handleChatCompletions
  // (OpenAI handler)，把 Anthropic body 打到 OpenAI 端点 → 上游 400。所以只要
  // markerOptIn=true 就必须显式注册这两条 anthropic/openai 5 段路由。
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/:agent/:spaceId/analyse/v1/messages", handleAnthropic);
    app.post("/:agent/:spaceId/analyse/v1/chat/completions", handleOpenAI);
  }

  app.post("/:agent/:spaceId/v1/messages", handleAnthropic);
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/chat/completions", handleOpenAI);

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", handleAnthropic);
  app.post("/:agent/v1/chat/completions", handleOpenAI);

  // Legacy /proxy/<spaceId>/ prefix — no agent info, defaults to codebuddy.
  // 保留以兼容不带 agent 前缀的客户端。
  app.post("/proxy/:spaceId/v1/messages", handleAnthropic);
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/*", handleOpenAI);

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", handleOpenAI);

  return app;
}

function classifyPublicPath(path: string): "local_sidecar" | "malformed" | "allowed" {
  let decoded = path;
  for (let depth = 0; depth < 3; depth++) {
    const normalized = canonicalizePath(decoded).toLowerCase();
    if (isLocalSidecarPath(normalized)) {
      return "local_sidecar";
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return "allowed";
      decoded = next;
    } catch {
      return "malformed";
    }
  }
  return "malformed";
}

function isLocalSidecarPath(path: string): boolean {
  return ["/hooks", "/knowledge-bridge", "/codex/manage"].some((namespace) =>
    path === namespace || path.startsWith(`${namespace}/`) || path.startsWith(`${namespace}%`)
  );
}

function canonicalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
