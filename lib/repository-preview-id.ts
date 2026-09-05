export function previewSandboxId(): string {
  return `preview-v12-${crypto.randomUUID().replaceAll("-", "")}`;
}
