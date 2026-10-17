# 0.2 工作区入口

默认 `./start-notes.sh` 打开笔记工作台，安装版使用 `slide-notes`。启动恢复上次工作区和笔记；空白工作台显示 Welcome，引导入口也在左侧文件夹栏。以下单笔记编辑说明继续适用；历史默认路径现在需要从首页选择原工作区打开。环境与安装见 [guides/workspaces.md](guides/workspaces.md)。

# Slide Notes · 我们自己的笔记

一个本地运行、以页面为组织单位的 Python 笔记工作台。可同时打开多个 Workspace 和笔记；Workspace 是你选择的普通文件夹，用户内容与应用安装目录分离。

## 启动

在仓库根目录运行：

```bash
./start-notes.sh
```

打开 http://127.0.0.1:2720 。终端按一次 **Ctrl+C**，同时停止 HTTP 服务和 Python 计算进程。

```bash
./start-notes.sh --port 3000
./start-notes.sh --document /绝对路径/另一份笔记.json
./start-notes.sh --workspace /工作区路径 --document /工作区路径/笔记.json
./start-notes.sh --help
```

指定 `--document` 时，文档路径不存在会以 `example.json` 初始化；存在时读取已有文档。默认启动器进入工作台，通过 Workspace 管理 `notebooks/` 中的笔记。

更新服务端代码后需要先在运行服务的终端按 Ctrl+C，再重新运行启动命令并刷新浏览器。旧服务不认识新增工作区接口时，界面会提示重启。

## 工作区面板

界面统一使用白底、蓝色交互、清晰的深蓝灰工作区文字和细边框；Markdown 正文使用系统字体，代码使用等宽字体，工具图标使用 Lucide。左侧图标栏可打开或收起各工具面板；页面侧栏的展开按钮属于当前笔记：

侧栏使用加粗标题、深蓝灰正文、蓝色选中标记和轻阴影；展开与悬停有短动效，遵循系统减少动态效果设置。顶部笔记标题增大字号，悬停和聚焦时显示编辑状态。放映时不显示选中 cell 的外框。

图标栏宽 44 像素，Files / Packages 默认宽 248 像素。拖动工具面板右边的分隔线调宽，各面板分别记住设置；双击恢复默认，聚焦后用左右方向键微调。它与 slide 列表的宽度相互独立。

- **Files**：切换“工作区文件／仅笔记”。目录树支持逐层展开，普通文件可只读预览；搜索跳过 `.venv`、`node_modules` 等依赖目录，但这些目录仍可在树中浏览。“仅笔记”递归查找符合本项目格式的 JSON 笔记与原版 marimo Python 文件。点击自制笔记直接切换，＋ 按钮新建笔记。原版 marimo 文件显示源码与原版启动方式，暂不导入自制编辑器。
- **Packages**：搜索当前 Python 环境实际安装的包，查看名称、版本与环境路径；当前为只读列表。
- **Variables**：紧凑的 Name / Type / Value 表格，可搜索、展开值，定位变量定义所在的 cell。
- **Outline**：按 slide 和 Markdown 标题层级显示大纲，包含代码输出中的 Markdown 标题。可搜索、展开／收起，标题编辑后实时更新。点击标题定位到对应 cell；放映中的 Fragment 自动展开，Skip 内容会切回编辑模式查看。支持独立调宽和宽度记忆。
- **Dependency graph**：点阵背景、输出变量节点、带箭头的依赖连线；支持横向／纵向自动布局、缩放、平移和展开。点击节点查看 Inputs / Outputs，点击连线查看传递的变量，双击节点定位代码。

底部资源条显示当前机器 CPU、系统内存与全部笔记 Python 会话的内存占用。数据读取失败时标为不可用。

“仅笔记”通过 Python 语法结构识别真正的 marimo App 声明，代码中的字符串、注释、测试样例不算笔记。内置 `src/slide_notes/example.json` 模板只在工作区文件中显示；用户自行保存的笔记即使同名或标题相同，也会分别保留。

## 使用方式

- 左侧新建、选择页面；页面上方直接改名，箭头调整顺序。打开或刷新时仅展开 Slides 页面侧栏，其他工具面板默认关闭。页面底部不再显示运行提示和翻页栏；点击左侧页面切换，放映时用左右方向键或空格逐步播放。左侧图标栏最上方的按钮收起／展开页面侧栏；收起后按钮仍保留。拖动 slide 列表右边的分隔线调整宽度，刷新后记住宽度设置；双击恢复默认。聚焦分隔线后可用左右方向键每次调整 10 像素。
- 每页可添加多个文本或 Python cell，支持调整顺序、删除。通过 cell 之间或页面开头、末尾的 ＋ 插入 Python 或 Markdown；空白页也保留 ＋ 入口。页面列表支持右键“删除页面”，最后一页不可删除。删除后不弹撤销提示；在编辑器外按 Ctrl/Cmd + Z 撤销、Ctrl/Cmd + Shift + Z（或 Ctrl + Y）重做。删除、添加、拖拽和布局调整均可撤销；每本笔记在当前窗口保留最近 50 步。编辑器内仍使用自身的文字撤销／重做。
- cell 四个边缘都可直接拖动；更多菜单的吸附开关按上、下、左、右的实际方位围绕中央方框排列，可分别关闭。左右边缘靠近其他 cell 或笔记边缘时自动吸附，相连左右边界默认联动。上下边缘可吸附其他列 cell 的上下边界及本 cell 的自然起点，并显示蓝色对齐线；拖上边缘调整纵向留白，拖下边缘调整高度，内容增长时仍自动撑开。Alt 拖动临时解除吸附；方向键微调，Esc 取消本次拖动，Ctrl+Z 撤销。左右边缘双击均分，上边缘双击恢复顶部对齐和自动高度，下边缘双击恢复自动高度。窄屏改为纵向堆叠时暂时忽略纵向留白。
- cell 右上角的 ＋ 菜单可以在下方（同列）或右侧添加 Python 或文字 / Markdown。每行最多 4 列，每列可独立堆叠多个 cell；右列增删内容不影响左列位置。右下角六点手柄可在本列上下移动（保持尺寸），拖动内容实时跟随指针；拖动时其他 cell 保持原位，不发生碰撞推开。越过同列其他 cell 的中线会显示上方／下方插入位置，松手后调整顺序，无需修饰键；未越过时可在已有空隙内微调，其他 cell 不被带动。拖到其他列 cell 上下边缘插入对应列，拖到左右边缘形成并排，拖到整行之间的 ＋ 区域则恢复为独立一行。落点有蓝色预览；Esc 取消，Ctrl+Z 撤销。手柄聚焦后上下方向键在本列调整顺序（列端微调留白），左右键调整列顺序。布局随笔记保存，编辑／放映共用；空间不足时自动上下排列，恢复空间后回到原布局。Fragment 保留自己的列位置，Skip 仍按原规则隐藏。

- 文本支持 Markdown、`$行内公式$` 和 `$$独立公式$$`，默认使用实时预览。文本 cell 与 Python 共用白底细边框、更多菜单、删除和拖动入口；点击文字编辑，编辑标题时大纲实时更新。视图按钮可切换实时预览、源码和阅读模式，Ctrl+Q 切换实时预览/源码，Ctrl+E 切换阅读/编辑。
- Python cell 使用白底细边框编辑器，支持行号、语法高亮、折叠、Tab 缩进和撤销／重做。右上角为运行、停止、添加和更多设置；Fragment / Skip、放映显示代码和删除 cell 收在更多菜单中。执行耗时和六点拖拽手柄收在右下角。页面标题和右侧操作按钮与 cell 内容区域两端对齐。
- 编辑模式下，点击 Python cell 右上角的“隐藏代码”可只保留输出和控件；点击同一位置的“展开代码”恢复编辑器，或选中 cell 后按 `C` 直接展开并聚焦。每个 cell 的折叠状态随笔记保存，刷新后保留；折叠不触发运行，不影响其他 cell，也独立于“放映时显示代码”开关。
- Python cell 的最后一个表达式作为输出；支持普通对象预览、`print`、Plotly Figure、`note.markdown(...)`。
- 修改代码后点 cell 的运行按钮或按 Shift + Enter，运行该 cell 及下游依赖；“运行全部”重新运行所有代码。滑杆变化自动执行所属 cell 及下游。
- 右上角在编辑／放映间切换。点击 cell 选中；`F` 切换全屏放映，`C` 返回编辑并聚焦选中的 cell（未选中时优先当前页的代码块）。输入框、编辑器和对话框中不会触发 F/C。放映隐藏编辑工具，代码按每个 cell 的“放映时显示代码”设置显示。方向键左右翻页，Esc 返回编辑。
- 每个 cell 的更多菜单统一使用 Slide / Fragment / Skip 三段切换，悬停或键盘聚焦时显示解释：Slide 随本页直接显示；Fragment 随右箭头逐个显示；Skip 放映时隐藏（Python 仍参与计算）。支持方向键切换选项，Esc 关闭菜单。Python 的“放映时显示代码”使用独立开关。没有 Vertical、Sub-slide 或 Command Palette。
- 左侧的依赖图和变量表可用于检查输入输出和当前运行结果。

## 控件与计算

Python 中内置 `note` 对象：

```python
x1 = note.slider("x₁", -2, 2, step=0.05, value=0.8, key="x1")
x2 = note.slider("x₂", -2, 2, step=0.05, value=-0.6, key="x2")
```

另一个 cell：

```python
height = x1**2 + x2**2
note.markdown(f"**高度：** {height:.3f}")
```

代码按变量依赖排序，不按页码排序。一个共享变量只能由一个 cell 定义；以下划线开头的临时变量按 cell 隔离。循环依赖、重复定义、上游错误会显示在相应 cell，失败的旧变量会失效。

这是独立的执行器，使用固定版本 marimo 的静态分析器识别变量关系，**并不是完整的 marimo 内核**。当前支持同步 Python、这里的 `note` 接口、常用 `mo.ui` 控件和 Plotly；异步 cell、SQL、完整富媒体插件与原版笔记文件导入尚未接入。外部对象的原地修改、动态 `exec` 等不能替代显式的变量依赖。

代码在本机 Python 中运行，与普通本地脚本拥有相同的文件访问能力，工作目录为当前 workspace。当前服务只监听本机；每本笔记拥有独立的 Python 会话，各本笔记的变量与运行状态互相隔离。运行中的 ■ 按钮会中断并重置当前笔记的会话；单次运行超过 20 秒自动中断。再次运行重建该会话，参数恢复代码初值。Ctrl+C 会停止服务下所有笔记的计算进程。

## 保存与状态

内容和页面设置停止输入约半秒后自动保存；也可以 Ctrl/Cmd + S。写入使用临时文件原子替换，并检测其他窗口的保存冲突；失败时界面会提示。导出按钮下载当前文档 JSON，也可通过 `--document` 打开导出的文件。

翻页、收起侧栏、编辑／放映切换以及同一页面内切换笔记保留各本笔记的参数与图形视角。切换前会先保存，保存失败则保持当前笔记。滑杆参数、运行变量、图形视角与 Fragment 进度不写入文档。服务重启后恢复初值；新浏览器窗口有自己的展示进度，同一服务下打开同一本笔记的窗口共享其 Python 会话。

## 安装与开发

使用 Python 3.12+、Node.js 22+。在仓库根目录：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm ci --prefix frontend
./start-notes.sh
```

开发环境位于根目录 `.venv`；安装版有独立应用环境，每个 Workspace 有自己的计算环境。前端依赖从本机提供，无需 CDN，也不需要前端编译服务器。

`frontend/src/styles/theme.css` 集中定义蓝白主题；`frontend/src/workbench/plot-theme.js` 为图表补充字体、轴线、网格和默认配色。新示例使用蓝色曲面，旧内置示例的绿色曲面在显示时兼容更新，不改写已保存的源码。自定义图表明确指定的颜色和字体会保留。

工作区采用 PT Sans / Fira Mono 字体、明确的中文黑体回退和统一的 Lucide 图标。所需字体、图标和许可证构建到 `src/slide_notes/static/`。更新这些依赖后，可运行 `npm run build:assets --prefix frontend` 重新生成本地资源。代码编辑器使用 CodeMirror 6；修改 `frontend/src/editor/editor-src.js` 或更新编辑器依赖后，运行 `npm run build:editor --prefix frontend` 重新生成静态 bundle。

```bash
npm run check --prefix frontend
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_*.py' -v
```

- `src/slide_notes/web/`：本地 HTTP API、文档保存、计算进程生命周期。
- `src/slide_notes/notebook/`：依赖分析、增量运行、marimo 适配与输出。
- `frontend/src/`：页面编辑器、放映、文件树和 AI 界面源码。
- `src/slide_notes/static/`：随安装包分发的离线资源。
- `src/slide_notes/example.json`：首次启动的示例，不会覆盖已有文档。
- Workspace 的 `notebooks/`：用户笔记，保存在用户所选目录，不收入源码发布包。

完整目录结构与开发边界见 [架构说明](development/architecture.md)。目前暂不含语言服务补全、完整调试器或画布图层。

## Agent CLI

项目根目录的 `./notes` 提供 JSON 命令行接口，支持页面／cell 编辑、批量原子保存与 dry-run、版本冲突检查、执行及运行状态读取。先运行 `./start-notes.sh`，再执行 `./notes --help`。完整命令、并排布局、错误码和示例见 [Agent 操作指南](guides/agent.md)。新增的运行快照接口需要重启旧服务后使用。

## marimo / mo 接入

自制笔记已接入真实 marimo 的常用 UI 对象：一个 cell 放控件，另一个读取 `.value` 更新图像；`mo.ui.plotly` 的点击、框选和套索结果也可驱动下游。更新后重启服务并刷新浏览器。完整支持列表、限制和 agent 写法见 [mo 接入说明](guides/mo.md)。左侧文件夹栏 → 工作区菜单 → 添加示例笔记，会把“mo · 双 cell 曲面联动”和“mo · 选点与下游分析”复制到 `notebooks/示例笔记/`。

AI 助手支持本机 Claude Code CLI 与 Chat Completions 兼容 API。会话属于整个 Workspace，当前打开的文件作为默认上下文；从左侧 AI 入口配置，或点击 cell 的星光按钮提及目标内容。详见 [AI 接入与使用](guides/ai.md)。

## Markdown 实时预览

默认编辑器在同一个文档内呈现正文和公式。点击混合文字/公式段落后，段内公式显示为彩色 TeX 源码，文字仍在原位编辑；离开段落后公式恢复编译。独立公式保留源码与编译预览，光标或选区对应的符号有填充高亮。拖选文字和彩色源码使用原生选区；已编译公式按符号映射到源文位置。

支持标题、列表、表格、任务、引用与 Callout、脚注、双链、图片、代码高亮、MathJax 公式和离线 Mermaid。视图切换不修改 Markdown、不写入撤销历史、不执行 Python。放映和阅读模式保持只读；Python 富输出继续使用 marimo 输出适配器。

修改 `markdown-*.js` 后运行 `npm run build:markdown --prefix frontend`；修改实时预览或编辑器后运行 `npm run build:editor --prefix frontend`。交互回归为 `npm run test:markdown-browser --prefix frontend` 与 `npm run test:markdown-app --prefix frontend`，仅使用临时内容。

## 导出 PDF 与打印

工作区菜单 → **导出 PDF / 打印…**，选择整个笔记或其中一页，支持 A4 横向／纵向。也可以右键左侧页面 → **导出此页 PDF / 打印…**，或在笔记中按 Ctrl+P（macOS 为 Cmd+P）。随后在浏览器打印窗口选择“另存为 PDF”或打印机。原来的 JSON 导出仍保留。

每个笔记页面从新纸页开始；长内容自动续页。打印版保留分栏、文字、公式、图片以及现有 Python 输出，Fragment 全部展开，Skip 不打印；Python 源码遵循 cell 的“显示源码”设置。不自动执行代码，过期输出会标明。导出在独立的打印文档内完成，不切换笔记或改变编辑状态。

PDF 浏览器回归验证（需要 Playwright、Chromium、Poppler，以及本机 socket 权限）：`.venv/bin/python scripts/verify_print_ui.py`。仅使用临时工作区，不读取用户笔记。

