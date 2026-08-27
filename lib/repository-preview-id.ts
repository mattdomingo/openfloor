export function previewSandboxId(): string {
  return `preview-v5-${crypto.randomUUID().replaceAll("-", "")}`;
}
