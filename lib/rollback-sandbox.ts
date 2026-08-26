const SANDBOX_ID_MAX_LENGTH = 63;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function rollbackSandboxIds(rollbackId: string): { executor: string; publisher: string } {
  if (!UUID_PATTERN.test(rollbackId)) throw new Error("Rollback identifier is invalid");
  const ids = {
    executor: `rollback-${rollbackId}`,
    publisher: `rollback-publisher-${rollbackId}`,
  };
  if (ids.executor.length > SANDBOX_ID_MAX_LENGTH || ids.publisher.length > SANDBOX_ID_MAX_LENGTH) {
    throw new Error("Rollback sandbox identifier exceeds the platform limit");
  }
  return ids;
}
