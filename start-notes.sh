#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$project_dir/.venv/bin/python" ]]; then
    printf '请先安装开发依赖，或运行 bash install.sh 安装应用。\n' >&2
    exit 1
fi
# Preserve the original single-document development entry point.
export PYTHONPATH="$project_dir/src${PYTHONPATH:+:$PYTHONPATH}"
for argument in "$@"; do
    if [[ "$argument" == --document || "$argument" == --document=* ]]; then
        exec "$project_dir/.venv/bin/python" -m slide_notes.web.server "$@"
    fi
done
exec "$project_dir/.venv/bin/python" -m slide_notes.launcher "$@"
