export const MAX_PACKAGE_JSON_BYTES: number;
export function detectRepositoryPreview(
  manifest: unknown,
  rootFiles: Set<string>,
): {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  script: "dev" | "start";
  installCommand: string[];
  runCommand: string[];
};
export function detectRepositoryPreviewAt(root: string): Promise<ReturnType<typeof detectRepositoryPreview>>;
export function selectSingleHttpPort(ports: number[]): number | null;
