type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
  } | null;
};

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizeSendMessageResult(response: JsonRpcEnvelope) {
  const result = response.result ?? {};

  return {
    accepted: asBoolean(result.accepted),
    delivered: asBoolean(result.delivered),
    state: asString(result.state),
    recipient: asString(result.recipient),
    taskId: asString(result.taskId),
    reply: asString(result.reply),
    replyExact: asString(result.reply),
    connectionRequested: asBoolean(result.connectionRequested),
    connectionStatus: asString(result.connectionStatus),
    senderConversationId: asString(result.senderConversationId),
    recipientConversationId: asString(result.recipientConversationId),
    error: response.error
      ? {
          code: response.error.code,
          message: response.error.message,
        }
      : undefined,
  };
}
