export const ROLLBACK_PREPARE_COMMAND = `rm -rf /workspace/repository && mkdir -p /workspace/repository && cd /workspace/repository &&
 git init -q && git remote add origin "$OPENFLOOR_REPOSITORY_URL" &&
 git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" fetch --no-tags --depth=1 origin "$OPENFLOOR_EXPECTED_SHA" &&
 git update-ref refs/openfloor/current FETCH_HEAD &&
 target_index=0 && for target_sha in $OPENFLOOR_TARGET_SHAS; do
   git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" fetch --no-tags --depth=2 origin "$target_sha" || exit $?;
   git update-ref "refs/openfloor/target-$target_index" FETCH_HEAD || exit $?;
   target_index=$((target_index + 1));
 done && git checkout -q --detach refs/openfloor/current &&
 git config user.name "OpenFloor Rollback" && git config user.email "rollback@opnflr.com" &&
 target_index=0 && for target_sha in $OPENFLOOR_TARGET_SHAS; do
   target_ref="refs/openfloor/target-$target_index";
   parent_count="$(git cat-file -p "$target_ref" | awk '$1 == "parent" { count += 1 } END { print count + 0 }')";
   if [ "$parent_count" = "1" ]; then git revert --no-commit "$target_ref" || exit $?;
   elif [ "$parent_count" = "2" ]; then git revert --no-commit -m 1 "$target_ref" || exit $?;
   else echo "unsupported parent count" >&2; exit 64; fi;
   target_index=$((target_index + 1));
 done &&
 GIT_AUTHOR_DATE="$OPENFLOOR_COMMIT_DATE" GIT_COMMITTER_DATE="$OPENFLOOR_COMMIT_DATE" git commit -q -m "$OPENFLOOR_COMMIT_MESSAGE" &&
 git rev-parse HEAD`;

export const ROLLBACK_PUBLISH_COMMAND = `cd /workspace/repository && git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" push "--force-with-lease=refs/heads/$OPENFLOOR_CANDIDATE_BRANCH:$OPENFLOOR_EXPECTED_SHA" "$OPENFLOOR_REPOSITORY_URL" "$OPENFLOOR_ROLLBACK_SHA:refs/heads/$OPENFLOOR_CANDIDATE_BRANCH"`;

// The git output can carry the installation token via the credential-less HTTP
// auth header (or, on some git builds, an authenticated remote URL echoed back
// in an error). Strip both before persisting output as a failure reason.
export function redactRollbackOutput(output: string, token: string): string {
  const withoutHeader = output.replace(/Authorization: Basic \S+/g, "Authorization: Basic [redacted]");
  const withoutToken = token ? withoutHeader.split(token).join("[redacted]") : withoutHeader;
  return withoutToken.slice(-500);
}
