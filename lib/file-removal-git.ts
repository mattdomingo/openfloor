export const FILE_REMOVAL_PREPARE_COMMAND = `rm -rf /workspace/repository && mkdir -p /workspace/repository && cd /workspace/repository &&
 git init -q && git remote add origin "$OPENFLOOR_REPOSITORY_URL" &&
 git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" fetch --no-tags --depth=1 origin "$OPENFLOOR_EXPECTED_SHA" &&
 git update-ref refs/openfloor/current FETCH_HEAD &&
 git -c credential.helper= -c "http.extraHeader=$OPENFLOOR_GIT_AUTHORIZATION" fetch --no-tags --depth=1 origin "$OPENFLOOR_BASE_SHA" &&
 git update-ref refs/openfloor/base FETCH_HEAD &&
 git checkout -q --detach refs/openfloor/current &&
 git config user.name "OpenFloor Review" && git config user.email "review@opnflr.com" &&
 if git cat-file -e "refs/openfloor/base:$OPENFLOOR_FILE_PATH" 2>/dev/null; then
   git restore --source=refs/openfloor/base --staged --worktree -- "$OPENFLOOR_FILE_PATH";
 else
   git rm -f -q --ignore-unmatch -- "$OPENFLOOR_FILE_PATH";
 fi &&
 if [ -n "$OPENFLOOR_PREVIOUS_FILE_PATH" ]; then
   if git cat-file -e "refs/openfloor/base:$OPENFLOOR_PREVIOUS_FILE_PATH" 2>/dev/null; then
     git restore --source=refs/openfloor/base --staged --worktree -- "$OPENFLOOR_PREVIOUS_FILE_PATH";
   else
     git rm -f -q --ignore-unmatch -- "$OPENFLOOR_PREVIOUS_FILE_PATH";
   fi;
 fi &&
 if git diff --cached --quiet; then echo "selected file no longer differs from base" >&2; exit 65; fi &&
 GIT_AUTHOR_DATE="$OPENFLOOR_COMMIT_DATE" GIT_COMMITTER_DATE="$OPENFLOOR_COMMIT_DATE" git commit -q -m "$OPENFLOOR_COMMIT_MESSAGE" &&
 git rev-parse HEAD`;
