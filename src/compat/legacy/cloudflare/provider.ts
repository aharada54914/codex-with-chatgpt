import type { Logger } from "../../../logger/index.js";
import { createWorkspaceTunnelProvider } from "./factory.js";
import type { TunnelProvider } from "../../../tunnel/provider.js";

export function createCloudflareTransportProvider(workspaceId: string, logger: Logger): TunnelProvider {
  return createWorkspaceTunnelProvider(workspaceId, logger);
}
