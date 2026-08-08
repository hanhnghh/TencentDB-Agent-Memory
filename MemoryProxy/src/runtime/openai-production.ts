/** @deprecated Import the protocol-neutral runtime provider from proxy-production. */
export {
  createProxyMemoryRuntime,
  createProxyMemoryRuntime as createOpenAIMemoryRuntime,
  type ManagedProxyMemoryRuntime,
  type ManagedProxyMemoryRuntime as ManagedOpenAIMemoryRuntime,
  type ProxyMemoryRuntimeAccess,
  type ProxyMemoryRuntimeAccess as OpenAIMemoryRuntimeAccess,
  type ProxyMemoryRuntimeProvider,
  type ProxyMemoryRuntimeProvider as OpenAIMemoryRuntimeProvider,
} from "./proxy-production.js";
