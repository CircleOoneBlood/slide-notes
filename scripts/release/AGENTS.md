# Slide Notes

本仓库仅包含 Slide Notes 应用源码、公开示例与测试。用户选择的 Workspace 保存在仓库之外；不得把个人笔记、论文、会话、API 密钥或运行配置加入公开提交。

- 修改笔记优先使用 `./notes` 或安装版 `slide-notes-agent`；先读 `docs/guides/agent.md`，通过 `workspace list`、`list`、`show --summary` 获取真实路径、ID 和 revision。
- 保存使用 `cell`、`slide` 或 `apply`；复杂修改先 `--dry-run`，携带读取时的 `--revision`。不要直接覆盖正在编辑的笔记 JSON。
- 测试仅使用临时 Workspace；不要修改用户笔记。
- 开发启动 `./start-notes.sh`；安装和依赖见 `README.md`。
- 验证：`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'`、`.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'`、`npm run check --prefix frontend`。浏览器测试需要 Chrome、Playwright 和本机 socket。
- Python 包在 `src/slide_notes/`，前端源码在 `frontend/`；分层边界见 `docs/development/architecture.md`。前端修改后执行 `npm run build --prefix frontend`。保留第三方许可证。
- 发布使用 `scripts/release.py`；新增模块、测试或夹具需登记到 `scripts/release-manifest.json`。不要将开发工作区整个目录直接上传。
