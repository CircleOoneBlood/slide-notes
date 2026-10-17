#!/usr/bin/env bash
# Install from a downloaded source release or a cloned repository, without sudo.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
    Linux) default_app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/slide-notes/app" ;;
    Darwin) default_app_dir="$HOME/Library/Application Support/Slide Notes/app" ;;
    *) printf '此脚本支持 Linux 和 macOS；Windows 请运行 install.ps1。\n' >&2; exit 1 ;;
esac
app_dir="${SLIDE_NOTES_INSTALL_DIR:-$default_app_dir}"
bin_dir="${SLIDE_NOTES_BIN_DIR:-$HOME/.local/bin}"
python_bin="${SLIDE_NOTES_PYTHON:-python3}"
"$python_bin" -c 'import sys; sys.exit("Slide Notes requires Python 3.12+") if sys.version_info < (3,12) else None'
app_dir="$("$python_bin" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().absolute())' "$app_dir")"
bin_dir="$("$python_bin" -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().absolute())' "$bin_dir")"
# A custom install directory must be empty or already belong to Slide Notes.
# The metadata check recognizes versions installed before ownership markers existed.
if [[ -e "$app_dir" || -L "$app_dir" ]]; then
    if [[ -L "$app_dir" || ! -d "$app_dir" ]]; then
        printf '未覆盖已有路径：%s\n' "$app_dir" >&2; exit 1
    fi
    "$python_bin" - "$app_dir" <<'PY'
import json, pathlib, subprocess, sys
base = pathlib.Path(sys.argv[1])
marker = base / '.slide-notes-install.json'
if marker.is_symlink():
    sys.exit(f'未覆盖已有路径：{marker}')
if marker.is_file():
    try:
        owned = json.loads(marker.read_text(encoding='utf-8')).get('application') == 'slide-notes'
    except (ValueError, OSError):
        owned = False
elif not any(base.iterdir()):
    owned = True
else:
    interpreter = base / 'bin/python'
    owned = interpreter.is_file() and subprocess.run([str(interpreter), '-I', '-c', 'import importlib.metadata; importlib.metadata.version("slide-notes-local")'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
if not owned:
    sys.exit(f'未覆盖不属于 Slide Notes 的安装目录：{base}')
PY
fi
mkdir -p "$app_dir" "$bin_dir"
if [[ ! -x "$app_dir/bin/python" ]]; then
    "$python_bin" -m venv "$app_dir"
fi
"$python_bin" - "$app_dir" <<'PY'
import json, pathlib, sys
(pathlib.Path(sys.argv[1]) / '.slide-notes-install.json').write_text(json.dumps({'application': 'slide-notes', 'format': 1}) + '\n', encoding='utf-8')
PY
"$app_dir/bin/python" -c 'import sys; sys.exit("Existing Slide Notes environment requires Python 3.12+; choose a new SLIDE_NOTES_INSTALL_DIR") if sys.version_info < (3,12) else None'
"$app_dir/bin/python" -m pip install --disable-pip-version-check --upgrade "$source_dir"
for executable in slide-notes slide-notes-agent; do
    if [[ ( -e "$bin_dir/$executable" || -L "$bin_dir/$executable" ) && ( ! -L "$bin_dir/$executable" || "$(readlink "$bin_dir/$executable")" != "$app_dir/bin/$executable" ) ]]; then
        printf '未覆盖已有文件：%s。应用可通过 %s/bin/%s 启动。\n' "$bin_dir/$executable" "$app_dir" "$executable" >&2
    else
        ln -sfn "$app_dir/bin/$executable" "$bin_dir/$executable"
    fi
done
"$app_dir/bin/python" -m slide_notes.launcher desktop install
printf '\n安装完成。可在应用菜单搜索 Slide Notes（macOS：~/Applications/Slide Notes.app），或运行：\n  "%s/bin/slide-notes"\n终端启动按 Ctrl+C 停止。笔记保存在你选择的 Workspace 中。\n' "$app_dir"
