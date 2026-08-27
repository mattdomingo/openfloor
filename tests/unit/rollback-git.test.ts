import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROLLBACK_PREPARE_COMMAND, ROLLBACK_PUBLISH_COMMAND, redactRollbackOutput } from "@/lib/rollback-git";

function parses(command: string): boolean {
  try {
    execFileSync("sh", ["-n"], { input: command });
    return true;
  } catch {
    return false;
  }
}

describe("rollback git commands", () => {
  it("prepare command parses as a single valid shell script", () => {
    expect(parses(ROLLBACK_PREPARE_COMMAND)).toBe(true);
  });

  it("publish command parses as a single valid shell script", () => {
    expect(parses(ROLLBACK_PUBLISH_COMMAND)).toBe(true);
  });

  it("catches a bare-newline regression that splits the push into unparsed fragments", () => {
    const broken = `cd /workspace/repository && git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" push
       "--force-with-lease=refs/heads/$OPENFLOOR_CANDIDATE_BRANCH:$OPENFLOOR_EXPECTED_SHA"
       "$OPENFLOOR_REPOSITORY_URL" "$OPENFLOOR_ROLLBACK_SHA:refs/heads/$OPENFLOOR_CANDIDATE_BRANCH"`;
    // sh -n happily parses this too (it's three legal, if pointless,
    // top-level statements) — the real bug is behavioral, not syntactic, so
    // assert on shape instead: the push arguments must stay on the same
    // logical command as `git push`, not spill onto a following line.
    expect(broken.trimStart().startsWith("cd /workspace/repository")).toBe(true);
    const pushLine = broken.split("\n").find((line) => line.includes(" push"))?.trim() ?? "";
    expect(pushLine.endsWith("push")).toBe(true);
    expect(ROLLBACK_PUBLISH_COMMAND.split("\n")).toHaveLength(1);
  });

  it("publishes with a force-with-lease guard pinned to the expected candidate SHA", () => {
    expect(ROLLBACK_PUBLISH_COMMAND).toContain("--force-with-lease=refs/heads/$OPENFLOOR_CANDIDATE_BRANCH:$OPENFLOOR_EXPECTED_SHA");
    expect(ROLLBACK_PUBLISH_COMMAND).toContain("$OPENFLOOR_ROLLBACK_SHA:refs/heads/$OPENFLOOR_CANDIDATE_BRANCH");
  });
});

describe("redactRollbackOutput", () => {
  it("strips the git HTTP authorization header", () => {
    const output = "remote: error\nfatal: could not read Username for 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA=='";
    const redacted = redactRollbackOutput(output, "ghs_secret");
    expect(redacted).not.toContain("Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==");
    expect(redacted).toContain("[redacted]");
  });

  it("strips a raw installation token if echoed back", () => {
    const redacted = redactRollbackOutput("fatal: repository 'https://x-access-token:ghs_secret@github.com/o/r.git/' not found", "ghs_secret");
    expect(redacted).not.toContain("ghs_secret");
  });

  it("bounds the output to the trailing 500 characters", () => {
    const output = "a".repeat(600) + "b".repeat(10);
    expect(redactRollbackOutput(output, "")).toHaveLength(500);
    expect(redactRollbackOutput(output, "")).toContain("b".repeat(10));
  });
});
