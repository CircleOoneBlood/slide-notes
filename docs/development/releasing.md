# 整理公开源码

发布工具将应用代码、锁文件、离线静态资源、第三方许可证、测试与明确审阅的示例复制到独立目录。它不扫描或导出 Workspace；`notebooks/`、资料目录、`.slide-notes/`、`.env*`、虚拟环境、会话与 `slide_notes/research/` 不在发布范围。导出目录不是用户数据备份。

1. 安装开发依赖并构建前端。

   ```bash
   python3 -m venv .venv
   .venv/bin/python -m pip install -e '.[dev]'
   npm ci --prefix frontend
   npm run build --prefix frontend
   ```

2. 执行 Python、发布工具和前端检查。浏览器测试需要 `/usr/bin/google-chrome`、Playwright、本机 socket；完整 PDF 和隔离命令验证还需要 Poppler、Bubblewrap 与 `prlimit`。测试仅用临时文件，不调用真实模型。

   ```bash
   PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'
   .venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
   npm run check --prefix frontend
   npm audit --prefix frontend
   node --test --test-concurrency=2 tests/frontend/test_*.cjs
   ```

3. 审阅 `scripts/release-manifest.json`，再执行受管理的发布。

   ```bash
   python3 scripts/release.py
   # 首次整理既有 dist 时，明确指定需保留的历史源码归档
   python3 scripts/release.py --history dist/前一版源码.tar.gz
   ```

   `dist/current/` 保存当前版本的源码目录与同名 `.tar.gz`，`dist/history/` 只保存前一版源码归档。后续发布自动轮转当前版本。工具先在临时目录导出并验证完整产物，再清理已经识别的旧发布目录和压缩包；遇到未知文件、符号链接或无效历史归档会停止，不自动删除这些内容。发布源码不能作为个人笔记备份。

   新增 Python/JavaScript 模块、文档或测试未登记时会报错；符号链接也会被拒绝。静态资源目录整体复制，新增静态资源应在审阅时确认属于应用。发布用 `AGENTS.md` 来自 `scripts/release/AGENTS.md`，不携带私人开发目录的说明。`SOURCE_MANIFEST.json` 记录每个文件的 SHA256；打包不会写入本机用户名或用户组。

   底层 `scripts/export_release.py --output /tmp/尚不存在的源码目录` 仍可用于独立验证。它拒绝覆盖已有输出，也不轮转或清理 `dist`。正式发布使用上面的 `release.py`，避免积累重复归档。

4. 在导出目录重新构建并安装 wheel，确认安装后的 CLI 和 HTTP 服务可启动。可在离线环境使用已有 Python/npm 依赖缓存；首次安装通常需要网络。对外发布前检查许可证、公开示例和文档，并从该目录新建 Git 仓库。

   ```bash
   cd dist/current/slide-notes-0.3.1-source
   python3 -m venv .venv
   .venv/bin/python -m pip install -e '.[dev]'
   npm ci --prefix frontend
   npm run check --prefix frontend
   npm run build:editor --prefix frontend
   npm run build:markdown --prefix frontend
   .venv/bin/python -m build
   ```

源码完整性检查不等同于依赖安全审计；对外发布前应单独查看 `npm audit`，评估修复并重新运行公式、图表和交互回归。这里的导出、构建与测试不会创建 GitHub 仓库，也不会上传源码或用户内容。依赖安装和审计会访问对应包仓库。当前内置 iLQR 测试夹具仅包含公开数学公式与通用说明文字，用于中文换行和混合公式选择回归，不含完整用户笔记。

## GitHub Release

公开仓库为 [CircleOoneBlood/slide-notes](https://github.com/CircleOoneBlood/slide-notes)。首次上传以经过清单导出的干净目录为 Git 根目录，不能直接提交包含个人资料的开发 Workspace。

更新版本时，同时修改 `pyproject.toml`、`src/slide_notes/__init__.py`、`frontend/package.json` 和 `frontend/package-lock.json` 的项目版本。提交并推送 `v版本` 标签，例如：

```bash
git tag v0.3.1
git push origin main
git push origin v0.3.1
```

Actions 首先核对标签与四处版本，然后构建前端、运行 Linux 完整回归、从清单导出源码并校验 wheel / sdist。相同 wheel 随后在 Linux、Windows、macOS 安装验证，覆盖桌面入口、中文路径、临时笔记与真实 Python worker；全部通过才创建 Release。发布包是需要 Python 3.12+ 的本地应用，不是自带解释器的 `.exe`、`.dmg` 或 AppImage。

Release 附件包含源码 `.zip` / `.tar.gz`、Python wheel / sdist、`RELEASE.json` 与 `SHA256SUMS`。源码 ZIP 中有 Linux / macOS 的 `install.sh` 与 Windows 的 `install.ps1`。用户下载解压后执行相应脚本，不需要 Node.js，也不需要克隆 Git。安装和新 Workspace 的 Python 依赖下载通常需要网络。PDF 文字提取另需 Poppler；隔离命令执行目前仅适用于安装了 Bubblewrap 0.8+ 和 `prlimit` 的 Linux。

本地可在一个尚不存在的临时目录构建同样的附件，不轮转正式 `dist`：

```bash
.venv/bin/python scripts/build_release.py --output /tmp/slide-notes-release-check
```

下载后核对 `SHA256SUMS`，例如 Linux 执行 `sha256sum -c SHA256SUMS`，macOS 执行 `shasum -a 256 -c SHA256SUMS`，Windows 执行 `Get-FileHash 文件名 -Algorithm SHA256` 并与清单比较。Release 的校验清单使用附件文件名，需把待核对附件放在同一目录。系统生成的 “Source code” 下载链接是 GitHub 的仓库快照；普通安装优先使用明确命名的 `slide-notes-版本-source.zip`。
