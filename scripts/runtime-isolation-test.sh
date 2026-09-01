#!/bin/sh
set -eu

scratch=/tmp/openfloor-isolation-test
provider_token='provider-token-must-not-cross-boundary'
mcp_token='mcp-token-must-not-cross-boundary'
[ "$(stat -c '%u:%g:%a' /opt/openfloor/runtime-identity)" = '0:0:4755' ]
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
  "filesystem": { "denyRead": [], "allowWrite": ["/tmp"], "denyWrite": [] }
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
bwrap_user=$(runuser -p -u openfloor-provider -- /opt/openfloor/openfloor-workspace-bwrap \
  --ro-bind / / --dev /dev --proc /proc /usr/bin/id -un)
[ "$bwrap_user" = 'openfloor-workspace' ]

kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
trap - EXIT
rm -rf "$scratch"
printf 'runtime-isolation-ok\n'
