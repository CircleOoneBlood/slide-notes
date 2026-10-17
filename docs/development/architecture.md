# 源码结构与开发边界

0.3.0 将运行代码、浏览器源码、测试、文档和发布产物分开。Python 使用标准 `src` 布局和 setuptools，前端继续用 esbuild 构建。CodeMirror 6、MathJax、PDF.js 和 Mermaid 各自负责编辑、公式、PDF 和图表；现有工作台交互保留。无需为了整理目录改写成 React/Vue，也不引入额外的前端运行服务。

```text
项目根目录/
├── src/slide_notes/                 # 可安装 Python 应用包
│   ├── application.py              # 工作区实例、环境与应用会话
│   ├── launcher.py                 # 桌面/开发启动、服务复用、停止
│   ├── cli.py                      # Agent 的 JSON CLI
│   ├── paths.py                    # 安装资源定位和源码工作区识别
│   ├── web/server.py               # HTTP 路由、保存接口、静态资源
│   ├── notebook/                   # 依赖图、内核进程、marimo 适配
│   │   ├── runtime.py
│   │   ├── kernel_worker.py
│   │   └── marimo_bridge.py
│   ├── workspace/                  # 文件操作、笔记迁移、可见性、图片
│   │   ├── file_ops.py
│   │   ├── storage.py
│   │   ├── visibility.py
│   │   └── image_files.py
│   ├── ai/                         # Agent 服务、模型接入、工具与上下文
│   │   ├── service.py
│   │   ├── tools.py
│   │   ├── workspace_tools.py
│   │   ├── claude.py
│   │   ├── command.py
│   │   ├── pdf_reader.py
│   │   ├── pdf_context.py
│   │   ├── selections.py
│   │   ├── sessions.py
│   │   ├── images.py
│   │   ├── sources.py
│   │   ├── tool_trace.py
│   │   ├── changes.py
│   │   └── branches.py
│   ├── examples/                   # 公开的内置示例
│   ├── example.json                # 新笔记模板
│   └── static/                     # 随 wheel 分发的离线构建产物
├── frontend/
│   ├── src/
│   │   ├── workbench/              # 工作台、标签、布局、历史、运行输出
│   │   ├── files/                  # 文件树、拖放、剪贴板
│   │   ├── ai/                     # 对话、流式渲染、上下文、选择
│   │   ├── pdf/                    # 阅读器、PDF 选择与 AI 引用
│   │   ├── editor/                 # CodeMirror 入口
│   │   ├── markdown/               # Markdown、公式与源码映射
│   │   └── styles/                 # CSS 源文件
│   ├── public/                    # HTML、图标与随源码维护的静态文件
│   ├── scripts/                   # esbuild、静态资源构建、语法检查
│   ├── package.json
│   └── package-lock.json
├── tests/
│   ├── backend/                   # unittest 与真实临时工作区的浏览器回归
│   ├── frontend/                  # Node/CJS 与浏览器前端回归
│   └── fixtures/                  # 审阅过的公开测试内容
├── docs/
│   ├── README.md                  # 编辑和使用说明
│   ├── guides/                    # Agent、AI、mo、Workspace 指南
│   └── development/               # 架构、发布、依赖审计
├── scripts/                       # 发布、包完整性检查、独立验证工具
├── dist/
│   ├── current/                   # 当前源码目录及压缩包
│   └── history/                   # 仅保留前一版源码压缩包
├── pyproject.toml                 # Python 依赖、入口、包资源
├── README.md
├── AGENTS.md
├── notes                          # 开发版 Agent CLI 入口
├── start-notes.sh                  # 开发版应用入口
└── install.sh                     # 安装桌面应用
```

原始开发工作区还包含 `notebook.py`、`notebook.css`、`start.sh`、`idea.md` 和个人资料。这些文件保持原路径；个人 `notebooks/`、`material/`、`picture/` 等内容与应用源码分开管理，不收入公开源码包。重构不搬动笔记，也不重写已保存的 JSON 或会话。

## 修改位置

新增或修改后端功能时使用 `slide_notes` 包的绝对导入，例如 `from slide_notes.ai.pdf_reader import available`。服务、内核、Workspace、AI 的实现分别进入对应子包。`application.py` 负责组织对象生命周期，`launcher.py` 和 `cli.py` 保持稳定的安装命令入口。

前端只编辑 `frontend/src/`、`frontend/public/` 和 `frontend/scripts/`。构建会将当前资源写入 `src/slide_notes/static/`；HTTP 资源 URL 保持 `/app.js`、`/file-tree.js`、`/editor.bundle.js` 等既有名字。不要直接修改生成的 bundle。安装包携带完整离线资源，用户安装 wheel 后无需 npm。

测试从自身位置统一定位源码：Python 的 `tests/backend/_paths.py` 和 Node 的 `tests/frontend/paths.cjs` 提供应用根、公开夹具及子进程路径。CLI 子进程通过 `python -m slide_notes.cli` 启动，并使用绝对 `PYTHONPATH`，避免临时工作区改变当前目录后导入失败。测试只创建临时 Workspace，模型与 Claude Code 服务使用模拟实现。

## 开发与验证

从仓库根目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm ci --prefix frontend
npm run check --prefix frontend
npm run build --prefix frontend
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'
.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
node --test --test-concurrency=2 tests/frontend/test_*.cjs
```

真实浏览器回归需要 Playwright、Chrome 和本机 socket；PDF/命令工具测试需要 Poppler、Bubblewrap 和 `prlimit`。安装、工作区恢复与数据目录见 [Workspace 指南](../guides/workspaces.md)，发布清单和源码导出见 [发布指南](releasing.md)。新增源码或测试必须登记到 `scripts/release-manifest.json`，由导出工具检查完整性与隐私边界。
