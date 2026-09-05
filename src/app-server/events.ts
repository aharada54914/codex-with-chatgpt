export type AppServerInternalEvent =
  | { kind: "turn_started"; threadId: string; turnId: string; raw: unknown }
  | { kind: "turn_terminal"; threadId: string; turnId: string; status: "completed" | "failed" | "interrupted"; raw: unknown }
  | { kind: "approval_requested"; method: string; raw: unknown }
  | { kind: "error"; message: string; raw: unknown }
  | { kind: "notification"; method: string; raw: unknown };

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

export function projectAppServerEvent(message: Record<string, unknown>): AppServerInternalEvent {
  const method = String(message.method);
  const params = message.params;
  if (method === "turn/started") {
    const turn = params && typeof params === "object" ? (params as Record<string, unknown>).turn : null;
    return { kind: "turn_started", threadId: stringField(params, "threadId"), turnId: stringField(turn, "id"), raw: message };
  }
  if (method === "turn/completed") {
    const turn = params && typeof params === "object" ? (params as Record<string, unknown>).turn : null;
    const status = stringField(turn, "status");
    return {
      kind: "turn_terminal",
      threadId: stringField(params, "threadId"),
      turnId: stringField(turn, "id"),
      status: status === "completed" || status === "failed" || status === "interrupted" ? status : "failed",
      raw: message,
    };
  }
  if (method.toLowerCase().includes("approval")) return { kind: "approval_requested", method, raw: message };
  if (method === "error") return { kind: "error", message: stringField((params as Record<string, unknown> | undefined)?.error, "message"), raw: message };
  return { kind: "notification", method, raw: message };
}
