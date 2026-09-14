export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (
    message.includes("No API key found") ||
    message.includes("No models available")
  ) {
    return "未找到可用模型。请配置 API_KEY、BASE_URL 和 MODEL_ID。";
  }
  return message;
}
