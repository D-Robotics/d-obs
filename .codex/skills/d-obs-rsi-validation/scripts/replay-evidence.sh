#!/bin/sh
set -eu
task_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
cd "$task_repo_root"
exec node --import tsx tools/rsi-real-evidence-smoke.mjs "$@"
