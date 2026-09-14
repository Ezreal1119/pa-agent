export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (
    message.includes("No API key found") ||
    message.includes("No models available")
  ) {
    return "未找到可用模型。请在项目根目录的 .env 中配置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY，然后重启服务。";
  }
  return message;
}
