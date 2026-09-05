/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. V1 ships a Cloudflare Quick Tunnel provider,
 * but ngrok / Tailscale / custom providers can be added without touching
 * the bridge.
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
  state: "running" | "stopped";
}

export interface TunnelDoctorReport {
  ok: boolean;
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
  errors: TunnelError[];
}

export type TunnelErrorCode =
  | "binary_not_found"
  | "start_timeout"
  | "process_exited"
  | "process_spawn_failed"
  | "start_stopped"
  | "health_check_failed"
  | "stop_failed";

export interface TunnelError {
  code: TunnelErrorCode;
  message: string;
  detail?: string;
}

export interface TunnelStartSuccess {
  ok: true;
  provider: string;
  url: string;
}

export interface TunnelStartFailure {
  ok: false;
  provider: string;
  error: TunnelError;
}

export type TunnelStartResult = TunnelStartSuccess | TunnelStartFailure;

export interface TunnelStopSuccess {
  ok: true;
  provider: string;
}

export interface TunnelStopFailure {
  ok: false;
  provider: string;
  error: TunnelError;
}

export type TunnelStopResult = TunnelStopSuccess | TunnelStopFailure;

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<TunnelStartResult>;
  stop(): Promise<TunnelStopResult>;
  restart(localPort: number): Promise<TunnelStartResult>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
