import type { TunnelProvider } from "./provider.js";
import { SecureMcpTunnelClient, type SecureMcpTunnelOptions } from "./secure-mcp.js";

export interface SecureMcpTransportConfig {
  kind: "secure-mcp";
  secureMcp: SecureMcpTunnelOptions;
}

export type TunnelTransportConfig = SecureMcpTransportConfig;

export function createTunnelProvider(config: TunnelTransportConfig): TunnelProvider {
  return new SecureMcpTunnelClient(config.secureMcp);
}

export function createSecureMcpTunnelProvider(options: SecureMcpTunnelOptions): TunnelProvider {
  return new SecureMcpTunnelClient(options);
}
