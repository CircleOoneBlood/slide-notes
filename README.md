# Slide Notes

本地运行、以页面组织的交互式 Python 笔记。文字、公式和代码可以放在同一页；用 `mo` 控件连接不同 cell，让参数驱动图像。蓝白色工作台提供 Files、Packages、Variables、Graph 和 Outline。

## 安装与启动

支持 Linux、Windows、macOS，需要 Python 3.12+（含 `venv`）和浏览器。从 [GitHub Release](https://github.com/CircleOoneBlood/slide-notes/releases/latest) 下载 `slide-notes-版本-source.zip` 并解压，在解压目录运行安装命令。

Linux / macOS：

```bash
bash install.sh
```

Windows（PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装器创建独立应用环境及 **Slide Notes** 入口：Linux 应用菜单、Windows 开始菜单、macOS 的 `~/Applications/Slide Notes.app`。Linux / macOS 命令位于 `~/.local/bin/`；Windows CLI 位于 `%LOCALAPPDATA%\SlideNotes\app\Scripts\`。不需要管理员权限或 Node.js。安装包包含浏览器资源；Python 本身和 Python 依赖需要另行安装或联网下载。它不是自带 Python 的独立可执行程序。

```bash
~/.local/bin/slide-notes
# 也可以直接打开一个已有工作区
~/.local/bin/slide-notes /绝对路径/我的笔记
```

启动后直接进入笔记工作台，恢复上次 Workspace 和笔记；首次使用在主区域显示 Welcome 引导。左侧文件夹栏顶部可打开、新建和切换最近工作区，并查看 Python 初始化进度、创建笔记和添加示例。终端启动按 **Ctrl+C** 停止服务及内核；再次点击桌面入口会复用已经运行的服务。默认地址 `http://127.0.0.1:2720`；占用时自动换端口。可用 `--port 2730` / `--no-browser`，桌面启动后可用 `slide-notes stop --port 实际端口` 停止。

从 [源码仓库](https://github.com/CircleOoneBlood/slide-notes) 克隆后也可使用对应安装命令。Release 中的 `.whl` 面向已配置 Python 虚拟环境的用户，安装后执行 `slide-notes desktop install` 注册入口。升级时先退出应用，再用新发布包重新执行安装器；Workspace 中的笔记和资料保留。

三种系统均可使用笔记、公式、Python cell、工作区和文件工具。Agent 的隔离命令执行需要 Linux Bubblewrap 0.8+ 与 `prlimit`，Windows / macOS 暂不提供这个工具。PDF 浏览不需要额外安装；Agent 提取 PDF 文字和页面图像需要 Poppler 的 `pdfinfo`、`pdftotext`、`pdftoppm`。本地 Claude Code 需在该设备上单独安装并登录。

## 工作区与笔记目录

- 应用安装与数据分离，每个 Workspace 是你选择的普通文件夹。
- 初始化时自动创建 `notebooks/`；“仅笔记”只显示这个专用目录，“工作区文件”显示整个 Workspace。空笔记文件夹会保留。
- 支持新建文件夹/笔记、右键重命名、拖动到文件夹、移到回收站与恢复。快捷键 `F2` 重命名、`Delete` 移到回收站。
- 文件操作不覆盖同名目标；文件已变更或正在运行时会拒绝冲突操作。删除文件夹会同时处理其中的普通文件，确认框显示完整文件数量。
- .slide-notes/workspace.json 记录笔记目录。首次升级自动将旧自制笔记迁入 `notebooks/`，按标题整理旧应用生成的笔记到目录根层，保留内容和用户自建目录，更新恢复路径；构建产物、内置模板与原版 marimo 入口排除。
- 每个 Workspace 的 Python 环境位于 `.slide-notes/venv/`。打开笔记不会自动执行代码，点“运行全部”开始计算。
- 本地文件夹不是沙箱；笔记 Python 使用当前用户权限运行。应用只监听本机，不提供远程托管服务。

详见 [Workspace 与安装说明](docs/guides/workspaces.md)、[笔记编辑说明](docs/README.md)、[mo 控件联动](docs/guides/mo.md)。

## PDF 阅读与 AI 解析

把 PDF 拖入 Workspace 或放入其文件夹，在目录树中点击打开。AI 对话默认提及当前 PDF；可以直接要求“继续阅读后面的页面”“搜索全文中的关键词，并整理成笔记”，也可指定 Workspace 内的相对路径。Agent 可按需读取任意页、检索全文，并将摘要或推导保存到 `notebooks/`，不必逐页手动翻动或反复附上整个文件。阅读器尚未就绪、当前页快照不可用时，仍可通过文件路径解析。

浏览器内阅读使用随应用提供的 PDF.js；Agent 的 PDF 解析需要本机 **Poppler**，并能在 PATH 中找到 `pdfinfo`、`pdftotext`、`pdftoppm`。Ubuntu/Debian 可使用 `sudo apt-get install poppler-utils` 安装。文字页直接提取文本，扫描页和需要确认的图表/公式可读取页面图像；不内置 OCR，图像理解取决于所配置模型。原 PDF 内容保持只读，解析结果可保存为笔记。详见 [AI 接入与使用](docs/guides/ai.md)。

## Agent CLI

```bash
slide-notes-agent workspace list
slide-notes-agent workspace open /绝对路径/我的笔记
slide-notes-agent --workspace 返回的ID list
slide-notes-agent --workspace 返回的ID --notebook notebooks/课程/函数.json show --summary
```

支持目录操作、页面和 cell 增删改移、原子批量修改、版本校验、运行和只读查询变量/依赖图。详见 [Agent 操作指南](docs/guides/agent.md)。

## 开发

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm ci --prefix frontend
./start-notes.sh
```

源码已包含前端构建产物。开发时使用 Node.js 22+，前端修改后执行 `npm run build --prefix frontend`，更新离线资源、编辑器和 Markdown 构建产物。浏览器回归使用 Playwright 和 Chrome；设置 `CHROME_BIN` 可指定部分 JavaScript 测试的浏览器，Python 浏览器测试默认使用 `/usr/bin/google-chrome`。PDF 文字提取需要 Poppler，AI 的隔离命令工具需要 Linux Bubblewrap 0.8+ 和 `prlimit`；未安装时这些工具会显示不可用。

```bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py'
npm run check --prefix frontend
.venv/bin/python -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/release.py
```

`src/slide_notes/` 是可安装 Python 包；`frontend/` 组织浏览器源码与构建工具；`tests/`、`docs/`、`scripts/` 分别放测试、文档和发布工具。完整分层和依赖边界见 [架构说明](docs/development/architecture.md)。发布导出采用 [可审阅的文件清单](scripts/release-manifest.json)，输出到 `dist/current/` 的源码目录和压缩包，`dist/history/` 仅保留前一版源码归档，不包含个人笔记、虚拟环境、会话、配置或本机逆向分析记录。新增应用模块未登记时导出会停止，避免生成缺文件的版本。目录中的 `SOURCE_MANIFEST.json` 记录每个发布文件的 SHA256。整理与验证流程见 [发布指南](docs/development/releasing.md)，可用导出的干净目录创建公开 Git 仓库。

当前依赖告警、已核实的影响范围与待升级项见 [前端依赖审计记录](docs/development/dependency-audit.md)。

单笔记开发入口支持 `./start-notes.sh --document /绝对路径/笔记.json`。升级时，旧版 `slide_notes/data/` 中的用户笔记会自动迁至 Workspace 的 `notebooks/`；用户内容不收入源码发布包。

## License

[MIT](LICENSE)。内置第三方字体、图标和 JavaScript 的许可证保留在 `src/slide_notes/static/licenses/`；第三方代码适用各自许可证。
## Markdown 单元格

默认使用基于本机 Obsidian 1.14.4 安装产物分析重建的实时预览。单元格的视图按钮可选择实时预览、源码、阅读；Ctrl+Q 切换实时预览/源码，Ctrl+E 切换阅读/编辑，Shift+Enter 插入换行。保留原始 Markdown 和现有 JSON cell 格式，不批量改写用户笔记。

正文采用 Obsidian 默认系统字体栈、16px 字号与 1.5 行距，标题、代码、表格、引用及 Callout 使用对应排版。渲染支持 GFM、任务、脚注、双链、标签、图片尺寸、彩色高亮、注释、块引用、MathJax CHTML 与离线 Mermaid；内部链接和显式嵌入适配 Note Workspace。旧 Marked/公式片段编辑入口已移除。Python 的 marimo 输出保留原有输出适配器。

该实现重建 Markdown 行为，不装载 Obsidian 私有代码、社区插件或自定义主题。本机分析记录与截图不随公开源码导出；操作细节见 [Agent 指南](docs/guides/agent.md)。

