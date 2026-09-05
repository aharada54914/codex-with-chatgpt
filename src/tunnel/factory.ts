import { createCloudflareTransportProvider } from "../compat/legacy/cloudflare/provider.js";
import { SecureMcpTunnelClient, type SecureMcpClientOptions } from "./secure-mcp.js";
import type { TunnelProvider } from "./provider.js";

export type TunnelMode = "secure-mcp" | "legacy-cloudflare";

export interface TunnelFactoryOptions {
  mode: TunnelMode;
  workspaceId: string;
  logger?: { info(message: string): void; error(message: string): void };
  secureMcp?: SecureMcpClientOptions;
}

export function createTunnelProvider(options: TunnelFactoryOptions): TunnelProvider {
  if (options.mode === "legacy-cloudflare") {
    return createCloudflareTransportProvider(options.workspaceId, options.logger as never);
  }
  if (!options.secureMcp) {
    throw new Error("secureMcp options are required when mode is \"secure-mcp\"");
  }
  return new SecureMcpTunnelClient(options.secureMcp) as unknown as TunnelProvider;
}
