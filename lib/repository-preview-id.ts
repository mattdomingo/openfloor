export function previewSandboxId(): string {
  return `preview-v11-${crypto.randomUUID().replaceAll("-", "")}`;
}
