# Workspace、安装与发布

## 数据目录

安装器不写入 Workspace。三种系统的默认应用目录与入口如下；配置目录可用 `SLIDE_NOTES_CONFIG_HOME` 覆盖。

| 系统 | 应用环境 | 配置 | 桌面入口 |
| --- | --- | --- | --- |
| Linux | `~/.local/share/slide-notes/app/` | `~/.config/slide-notes/` | 应用菜单与可用的桌面目录 |
| macOS | `~/Library/Application Support/Slide Notes/app/` | `~/Library/Application Support/slide-notes/` | `~/Applications/Slide Notes.app` |
| Windows | `%LOCALAPPDATA%\SlideNotes\app\` | `%APPDATA%\slide-notes\` | 开始菜单的 Slide Notes |

Linux / macOS 的命令安装到 `~/.local/bin/`，Windows 的 PowerShell 包装脚本安装到 `%LOCALAPPDATA%\SlideNotes\bin\`，原生 CLI 位于 `%LOCALAPPDATA%\SlideNotes\app\Scripts\`；不自动修改系统 PATH。`recent.json`、`session.json` 和 `ai.json` 都在相应配置目录。

```text
任意选定的 Workspace/
├── notebooks/
│   └── 课程/
│       └── 函数.json                          # 普通笔记文件，可复制和备份
├── data.csv                              # 文件模式显示，笔记模式隐藏
└── .slide-notes/
    ├── workspace.json                  # notesDirectory: notebooks
    ├── notes-migration.json             # 原路径、新路径、内容校验和迁移状态
    ├── environment.json                  # 环境初始化成功标记
    ├── venv/                             # 工作区独立 Python
    └── trash/                            # 被删除文件，可恢复
```

环境初始化在后台执行，左侧文件夹栏的工作区菜单 →「Python 运行环境」显示进度、日志和失败重试。未完成时可以编辑 Markdown；Python 必须等环境就绪。每个笔记拥有独立内核，同一 Workspace 共用安装的包。初始包为 marimo、NumPy、Plotly；mo 支持范围见 [mo.md](mo.md)。现有 `requirements.txt` 不会被自动执行。

添加其他包（替换成自己的 Workspace 路径）：

```bash
"/绝对路径/Workspace/.slide-notes/venv/bin/python" -m pip install pandas
```

Windows 对应命令为 `& "C:\路径\Workspace\.slide-notes\venv\Scripts\python.exe" -m pip install pandas`。

安装后 Packages 最多约 30 秒更新；已导入模块的内核需停止再运行。工作区可以复制到其他位置，但虚拟环境包含绝对路径，迁移时只复制笔记/数据，不复制 `.slide-notes/venv` 和 `environment.json`，然后重新初始化。

## 启动与恢复

启动直接显示笔记工作台，恢复上次打开的 Workspace 和该工作区最后打开的笔记。恢复记录保存在本机配置文件中，更换浏览器或端口也有效；恢复不会自动运行 Python。首次使用或没有打开笔记时，中央显示 Welcome，可以打开/新建工作区或选择最近目录。左侧文件夹栏顶部提供同样的工作区操作。

选择「关闭工作区」后，下次启动保持 Welcome；已记住的各工作区笔记位置仍保留。目录被移走或删除时显示提示，可从文件夹栏重新选择路径；笔记被删除时打开该工作区中其他可用笔记。

## 文件操作规则

工作区初始化先创建 `notebooks/`（不依赖 Python 包安装成功），笔记根目录记录在 `.slide-notes/workspace.json` 的 `notesDirectory`。新建笔记默认写入这里，指定子目录需使用工作区相对路径，例如 `notebooks/课程`。专用根目录不能被文件操作菜单删除或移动。

“笔记与 PDF”从 `notebooks/` 开始，保留真实子文件夹层次，显示 Slide Notes JSON、识别出的 marimo Python 笔记和 PDF。PDF 可直接点击打开，也会参与搜索；目录外的资料请在“工作区文件”查看。代码、构建目录和配置不会出现在此视图。marimo 笔记仅提供源文件预览；自制笔记可直接切换编辑。搜索递归匹配文件路径与笔记标题。

文件夹右键可创建子文件夹/笔记；工具栏在当前选中的文件夹中创建，点击目录标题回到根目录。拖放到文件夹或根目录标题可移动；右键“移动到…”可以输入相对目录。“笔记与 PDF”显示笔记标题，右键重命名会同步更新标题和 JSON 文件名；“工作区文件”显示实际文件名。顶部标题编辑会更新笔记列表显示名称。

删除进入当前 Workspace 回收站，恢复位置冲突时拒绝覆盖。文件操作不属于 cell 的 Ctrl+Z 历史；删除文件通过回收站恢复，移动/重命名通过反向操作恢复。回收站不会自动清空。笔记与 PDF 模式下删除文件夹也包括隐藏的普通文件，因此确认框显示两类文件数量。

文件树每 4 秒刷新一次，保留展开状态；外部修改笔记内容不会覆盖当前编辑器，保存遇到版本冲突时需先导出当前内容，再刷新。多窗口编辑同一文件同样执行版本检查。

## 启停、升级和卸载

终端启动用 Ctrl+C 停止。桌面启动使用同一后台服务；关闭网页不会停止内核。运行 `slide-notes stop --port 2720` 可停止桌面启动的服务及内核。默认端口被旧版或其他程序占用时，应用自动尝试 2721–2729；浏览器地址显示实际端口，CLI 的 `--url` 和 stop 的 `--port` 需要保持一致。显式指定的 `--port` 若被其他程序占用则报错。

升级：先退出应用，在新 Release 源码目录重新执行 `bash install.sh`（Linux / macOS）或 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`（Windows），然后重新启动。安装路径可通过 `SLIDE_NOTES_INSTALL_DIR` / `SLIDE_NOTES_BIN_DIR` 指定；Linux 桌面数据与配置遵守 `XDG_DATA_HOME` / `XDG_CONFIG_HOME`。Windows 命令只为该安装进程放行脚本，不更改持久的执行策略。自定义 Python 可用 `SLIDE_NOTES_PYTHON` 指定可执行文件路径。

卸载只需删除上表的应用环境、对应命令链接或包装脚本和桌面入口；Linux 图标位于 `~/.local/share/icons/hicolor/scalable/apps/slide-notes.svg`。保留 Workspace 即可保留笔记。应用配置可单独备份或删除。

## 发布

运行 `python3 scripts/release.py`，生成 `dist/current/` 中的干净源码目录及 `.tar.gz`，`dist/history/` 仅保留一个历史源码归档。新版本完整验证后才清理已识别的旧发布产物；未知文件和符号链接不会自动删除。检查导出目录，再把该目录初始化为 GitHub 仓库。原目录包含用户私人资料，不能直接整体上传。

在干净源码中 `python -m pip install build && python -m build` 可生成 wheel 和 sdist。wheel 自带浏览器资源和许可证，安装不依赖 npm。GitHub Actions 对 Linux 执行完整回归，并在三种系统安装同一 wheel、检查桌面入口、临时 Workspace 与真实 Python worker。版本标签通过全部检查后生成 [GitHub Release](https://github.com/CircleOoneBlood/slide-notes/releases)；流程与校验文件见 [发布指南](../development/releasing.md)。

## 旧笔记自动迁移

首次打开旧工作区时，校验其自制 JSON 笔记并移入 `notebooks/`，原字节内容保持不变。旧应用 `slide_notes/data/` 中的笔记直接放在根层，按标题命名，例如 `slide_notes/data/note-随机ID.json` → `notebooks/iLQR.json`；其他用户自建目录保留相对层次。已迁入旧嵌套结构的笔记也会自动整理，空的 `slide_notes/data` 中间层会清理。同名目标保留，迁入文件追加 `-migrated-N`；原版 marimo Python、非笔记 JSON、构建/发布/缓存目录和应用内置示例不迁移。计算工作目录仍是 Workspace 根目录，数据文件与 Python 模块留在原位置。

初始迁移记录在 `notes-migration.json`，旧布局整理记录在 `notes-layout.json`（均位于 `.slide-notes/`）。迁移前保存计划及 SHA-256，迁移后逐项记录完成状态。中断后再次打开工作区会续接；恢复记录与旧笔记 URL 会映射到新路径。迁移只在旧工作区升级时执行一次；以后请在专用目录创建笔记，外部文件可用“工作区文件”手动移入。

## 编辑区标签页与 PDF

标签栏位于应用顶部，笔记名称在左侧页面栏顶部直接编辑。F 切换放映，Esc 返回编辑；代码运行使用 cell 内按钮或 Shift+Enter。保存状态在底部状态栏显示。

同一工作区可以打开多本笔记和 PDF。点击左侧文件树会新增或选中一个标签页；同一文件不会重复打开。标签右侧 ×（或鼠标中键）只关闭标签，不删除文件；＋ 新建笔记。标签获得焦点时可用左右方向键切换，Delete 关闭。

切换和关闭前会保存当前笔记，保存失败时保留当前编辑内容。笔记切换保留当前页面、滚动位置、编辑/放映状态和运行结果；每个笔记仍有独立 Python 会话。关闭程序后，下次恢复该工作区的标签列表及所选标签。全部关闭后显示 Welcome。重命名、移动和删除文件会同步标签。

PDF 从「工作区文件」视图打开，标签内使用本地打包的 Mozilla PDF.js 6.4.299 阅读器。支持文字选择/复制、全文搜索（Ctrl+F）、目录、页码跳转、适应宽度/整页、缩放、旋转及下载原文件；密码保护的文档会提示输入密码。各 PDF 的页码、缩放和旋转在本机浏览器保存。右上角保留浏览器阅读器入口作为兼容性备用。扫描件未做 OCR，图片中的文字不能直接搜索。PDF 不会作为笔记运行，也不会被笔记自动保存覆盖。HTTP `/api/pdf?workspace=ID&path=相对路径` 支持 HEAD、Range 和 `download=1`，只允许读取当前工作区内的 PDF。

会话保存在应用配置目录的 `session.json`：`editors[workspaceID]` 记录 `tabs: [{kind: "notebook" | "pdf", path}]` 与 `active` 路径。CLI 操作笔记仍需显式指定 `--workspace` 和 `--notebook`，不随浏览器标签切换。

PDF.js 的 Worker、CJK 字符映射、标准字体、ICC 配置和 WASM 解码器均随安装包本地分发，无 CDN 依赖；许可证见 `static/licenses/pdfjs.txt`。渲染使用 PDF.js 自带的可见页队列与页面缓存，canvas 像素预算有上限。
