import type { Logger } from "../logger/index.js";
import { CloudflaredNamedTunnel } from "./cloudflared-named.js";
import { CloudflaredQuickTunnel } from "./cloudflared.js";
import { namedTunnelBinding, readTunnelState } from "./state.js";
import type { TunnelProvider } from "./provider.js";

export function createWorkspaceTunnelProvider(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}
