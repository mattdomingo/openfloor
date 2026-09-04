#!/bin/sh
set -eu

scratch=/tmp/openfloor-isolation-test
provider_token='provider-token-must-not-cross-boundary'
mcp_token='mcp-token-must-not-cross-boundary'
[ "$(stat -c '%u:%g:%a' /opt/openfloor/runtime-identity)" = '0:0:4755' ]
[ "$(stat -c '%u:%g:%a' /opt/openfloor/openfloor-workspace-handoff)" = '0:0:555' ]
[ "$(readlink /opt/openfloor/openfloor-preview-exec)" = runtime-identity ]
[ "$(readlink /opt/openfloor/openfloor-preview-bwrap)" = runtime-identity ]
rm -rf "$scratch"
mkdir -p "$scratch" /tmp/openfloor/workspace-home
chown openfloor-provider:openfloor-shared "$scratch"
chmod 0770 "$scratch"
chown openfloor-workspace:openfloor-shared /tmp/openfloor/workspace-home
chmod 0700 /tmp/openfloor/workspace-home
printf '%s\n' 'provider-home-secret' >/home/openfloor-provider/private-token
chown openfloor-provider:openfloor-shared /home/openfloor-provider/private-token
chmod 0600 /home/openfloor-provider/private-token

cat >/tmp/openfloor/workspace-srt-settings.json <<'JSON'
{
  "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": [] },
  "filesystem": { "denyRead": [], "allowWrite": ["/tmp"], "denyWrite": [] },
  "bwrapPath": "/opt/openfloor/openfloor-workspace-bwrap"
}
JSON
chmod 0444 /tmp/openfloor/workspace-srt-settings.json

OPENFLOOR_OPENAI_TOKEN="$provider_token" \
OPENFLOOR_CONTEXT_TOKEN="$mcp_token" \
runuser -p -u openfloor-provider -- \
  /opt/openfloor/openfloor-provider-exec sh -c 'echo $$ > /tmp/openfloor-isolation-test/provider.pid; exec sleep 60' &
holder=$!
trap 'kill "$holder" 2>/dev/null || true; rm -rf "$scratch"' EXIT

attempt=0
while [ ! -s "$scratch/provider.pid" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo 'provider process did not start' >&2; exit 1; }
  sleep 0.1
done
provider_pid=$(cat "$scratch/provider.pid")

cat >"$scratch/attack.sh" <<'SH'
#!/bin/sh
set -eu
provider_pid=$1
[ "$(id -un)" = openfloor-workspace ]
[ "$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status)" = 1 ]
[ "$(awk '/^CapEff:/ { print $2 }' /proc/self/status)" = 0000000000000000 ]
[ "${OPENFLOOR_OPENAI_TOKEN-}" = '' ]
[ "${OPENFLOOR_CONTEXT_TOKEN-}" = '' ]
! cat "/proc/$provider_pid/environ" >/tmp/openfloor-isolation-test/environ 2>/dev/null
! cat "/proc/$provider_pid/mem" >/tmp/openfloor-isolation-test/mem 2>/dev/null
! ls -l "/proc/$provider_pid/fd" >/tmp/openfloor-isolation-test/fds 2>/dev/null
! cat /home/openfloor-provider/private-token >/tmp/openfloor-isolation-test/home 2>/dev/null
found=''
for environment in /proc/[0-9]*/environ; do
  values=$(tr '\000' '\n' <"$environment" 2>/dev/null || true)
  case "$values" in *token-must-not-cross-boundary*) found=yes ;; esac
done
[ "$found" = '' ]
! ps -eo args | grep -v grep | grep 'token-must-not-cross-boundary'
printf 'workspace-boundary-ok\n'
SH
chmod 0755 "$scratch/attack.sh"

output=$(OPENFLOOR_OPENAI_TOKEN="$provider_token" \
  OPENFLOOR_CONTEXT_TOKEN="$mcp_token" \
  runuser -p -u openfloor-provider -- \
  /opt/openfloor/openfloor-workspace-exec "$scratch/attack.sh" "$provider_pid")
[ "$output" = 'workspace-boundary-ok' ]

shell_user=$(runuser -p -u openfloor-provider -- /opt/openfloor/workspace-shell/bash -c 'id -un')
[ "$shell_user" = 'openfloor-workspace' ]
case "$(uname -m)" in
  x86_64) seccomp_arch=x64 ;;
  aarch64|arm64) seccomp_arch=arm64 ;;
  *) echo 'unsupported seccomp test architecture' >&2; exit 1 ;;
esac
apply_seccomp=/opt/openfloor/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/$seccomp_arch/apply-seccomp
bwrap_user=$(runuser -p -u openfloor-provider -- /opt/openfloor/openfloor-workspace-bwrap \
  --ro-bind / / --dev /dev --unshare-user --unshare-net --unshare-pid --cap-drop ALL --proc /proc -- \
  /bin/bash -c "$apply_seccomp /usr/bin/id -un")
[ "$bwrap_user" = 'openfloor-workspace' ]
! runuser -p -u openfloor-workspace -- /opt/openfloor/openfloor-workspace-bwrap \
  --ro-bind / / --dev /dev --unshare-user --unshare-net --unshare-pid --cap-drop ALL --proc /proc -- \
  /bin/bash -c "$apply_seccomp /usr/bin/id -un" \
  >/tmp/openfloor-isolation-test/workspace-bwrap 2>&1
! runuser -p -u openfloor-workspace -- /opt/openfloor/openfloor-workspace-handoff /usr/bin/id -un \
  >/tmp/openfloor-isolation-test/workspace-handoff 2>&1
! runuser -p -u openfloor-provider -- /opt/openfloor/openfloor-workspace-bwrap \
  --ro-bind / / --dev /dev --unshare-user --unshare-net --unshare-pid --cap-drop ALL --uid 0 --proc /proc -- \
  /bin/bash -c "$apply_seccomp /usr/bin/id -un" \
  >/tmp/openfloor-isolation-test/forged-uid 2>&1

# Preview dependency installs use each frozen root lockfile while suppressing
# repository lifecycle scripts. Fixtures use only a local file dependency, so
# this gate needs no registry access and isolates package-manager behavior.
for manager in npm pnpm yarn bun; do
  fixture="$scratch/$manager"
  mkdir -p "$fixture/dependency"
  cat >"$fixture/dependency/package.json" <<'JSON'
{"name":"fixture-dependency","version":"1.0.0"}
JSON
  case "$manager" in
    npm) manager_version=$(npm --version) ;;
    pnpm) manager_version=$(pnpm --version) ;;
    yarn) manager_version=$(yarn --version) ;;
    bun) manager_version=$(bun --version) ;;
  esac
  cat >"$fixture/package.json" <<JSON
{"name":"preview-$manager","version":"1.0.0","private":true,"packageManager":"$manager@$manager_version","scripts":{"preinstall":"touch lifecycle-ran","dev":"node server.mjs"},"dependencies":{"fixture-dependency":"file:./dependency"}}
JSON
  case "$manager" in
    npm) (cd "$fixture" && npm install --package-lock-only --ignore-scripts --no-audit) ;;
    pnpm) (cd "$fixture" && pnpm install --lockfile-only --ignore-scripts) ;;
    yarn) (cd "$fixture" && yarn install --mode=skip-build) ;;
    bun) (cd "$fixture" && bun install --lockfile-only --ignore-scripts) ;;
  esac
  chown -R openfloor-workspace:openfloor-shared "$fixture"
  /opt/openfloor/openfloor-workspace-exec node /opt/openfloor/repository-preview.mjs --install "$fixture" "$fixture/config.json"
  [ ! -e "$fixture/lifecycle-ran" ]
  grep -q '"packageManager":"'"$manager"'"' "$fixture/config.json"
done

# Runtime uses workspace uid, has no outbound network, and exposes HTTP only
# through its Unix socket. Outer relay remains trusted Workflow-owned process.
rm -rf /workspace/repository /workspace/preview-relay
mkdir -p /workspace/repository /workspace/preview-relay
cat >/workspace/repository/package.json <<'JSON'
{"name":"preview-runtime","version":"1.0.0","private":true,"scripts":{"dev":"node server.mjs"}}
JSON
cat >/workspace/repository/server.mjs <<'JS'
import http from "node:http";
import net from "node:net";
import { writeFileSync } from "node:fs";
http.get("http://1.1.1.1", () => writeFileSync("/workspace/repository/outbound", "unexpected"))
  .on("error", () => writeFileSync("/workspace/repository/outbound", "blocked"));
net.connect("/workspace/preview-relay/preview.sock")
  .on("connect", () => writeFileSync("/workspace/repository/unix-socket", "unexpected"))
  .on("error", () => writeFileSync("/workspace/repository/unix-socket", "blocked"));
http.createServer((_request, response) => response.end(`uid=${process.getuid()}`)).listen(3456, "0.0.0.0");
JS
chown -R openfloor-workspace:openfloor-shared /workspace
chmod 0700 /tmp/openfloor/workspace-home
chmod 0644 /tmp/openfloor/workspace-srt-settings.json
cat >/tmp/openfloor/workspace-srt-settings.json <<'JSON'
{
  "network": { "allowedDomains": [], "deniedDomains": [], "allowAllUnixSockets": true },
  "filesystem": { "denyRead": [], "allowWrite": ["/workspace/repository", "/workspace/preview-relay", "/tmp"], "denyWrite": [] },
  "bwrapPath": "/opt/openfloor/openfloor-preview-bwrap"
}
JSON
chmod 0444 /tmp/openfloor/workspace-srt-settings.json
/opt/openfloor/openfloor-preview-exec npm dev >"$scratch/preview.log" 2>&1 &
preview_pid=$!
attempt=0
while [ ! -S /workspace/preview-relay/preview.sock ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 200 ] || { cat "$scratch/preview.log" >&2; exit 1; }
  sleep 0.1
done
chown root:root /workspace/preview-relay
chmod 0555 /workspace/preview-relay
chown root:openfloor-shared /workspace/preview-relay/preview.sock
chmod 0660 /workspace/preview-relay/preview.sock
[ "$(curl --silent --unix-socket /workspace/preview-relay/preview.sock http://localhost/)" = 'uid=10002' ]
! curl --silent --max-time 1 http://127.0.0.1:3456/ >/dev/null 2>&1
attempt=0
while [ ! -s /workspace/repository/outbound ] || [ ! -s /workspace/repository/unix-socket ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || exit 1
  sleep 0.1
done
[ "$(cat /workspace/repository/outbound)" = blocked ]
[ "$(cat /workspace/repository/unix-socket)" = blocked ]
kill "$preview_pid" 2>/dev/null || true
wait "$preview_pid" 2>/dev/null || true
chmod 0755 /workspace/preview-relay
rm -rf /workspace/repository /workspace/preview-relay

kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
trap - EXIT
rm -rf "$scratch"
printf 'runtime-isolation-ok\n'
