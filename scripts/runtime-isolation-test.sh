#!/bin/bash
set -euo pipefail
node /opt/openfloor/runtime-isolation-test.mjs
exec node /opt/openfloor/runtime-provider-test.mjs
