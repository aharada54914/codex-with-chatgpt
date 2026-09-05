import { nullLogger, type Logger } from "../logger/index.js";
import { createCloudflareTransportProvider } from "../compat/legacy/cloudflare/provider.js";
import { SecureMcpTunnelClient, type SecureMcpTunnelOptions } from "./secure-mcp.js";
import type { TunnelProvider } from "./provider.js";

export interface SecureMcpTransportConfig {
  kind: "secure-mcp";
  secureMcp: SecureMcpTunnelOptions;
}

export interface LegacyCloudflareTransportConfig {
  kind: "legacy-cloudflare";
  workspaceId: string;
  logger?: Logger;
}

export type TunnelTransportConfig = SecureMcpTransportConfig | LegacyCloudflareTransportConfig;

export function createTunnelProvider(config: TunnelTransportConfig): TunnelProvider {
  if (config.kind === "secure-mcp") {
    return new SecureMcpTunnelClient(config.secureMcp);
  }
  return createCloudflareTransportProvider(config.workspaceId, config.logger ?? nullLogger);
}

export function createSecureMcpTunnelProvider(options: SecureMcpTunnelOptions): TunnelProvider {
  return new SecureMcpTunnelClient(options);
}
