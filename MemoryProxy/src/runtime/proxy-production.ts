/** @deprecated Import the transport-neutral production runtime instead. */
export * from "./production.js";
export {
  createMemoryRuntime as createProxyMemoryRuntime,
  type ManagedMemoryRuntime as ManagedProxyMemoryRuntime,
  type MemoryRuntimeAccess as ProxyMemoryRuntimeAccess,
  type MemoryRuntimeProvider as ProxyMemoryRuntimeProvider,
} from "./production.js";
