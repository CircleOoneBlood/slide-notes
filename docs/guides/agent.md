# Slide Notes：Agent 命令行操作指南

本指南操作的是自制 Slide Notes JSON 笔记；原版 marimo 的 `notebook.py` 继续使用 `./start.sh`。从项目根目录运行 `./notes`，不需要模拟浏览器点击。

## 1. 启动与发现

一个终端启动服务（前台运行，Ctrl+C 停止服务及所有内核）：

```bash
./start-notes.sh
```

另一个终端操作：

```bash
./notes --help
./notes status
./notes list
./notes show --summary
```

默认连接 `http://127.0.0.1:2720`，默认笔记是服务启动时指定的笔记，**不随浏览器当前选中笔记变化**。操作已有笔记时优先显式指定路径：

```bash
./notes --notebook notebooks/函数，成为一张曲面.json show --summary
./notes --url http://127.0.0.1:2730 --notebook notes/demo.json show
```

`--url` / `--notebook` 放在子命令之前。也可设 `SLIDE_NOTES_URL` / `SLIDE_NOTES_NOTEBOOK`。笔记路径相对于**服务的 workspace**；源码文件、批量操作文件相对于**CLI 当前工作目录**。脚本自身可从任意目录调用。

若 `runtime` 报“服务版本较旧”，在服务终端 Ctrl+C，再执行 `./start-notes.sh`。不要额外启动一个占用同一端口的服务。

## 2. 推荐工作流程

1. `list` 找笔记；`show --summary` 获取页面和 cell 的稳定 ID。
2. `show --cell ID` 读取待修改源码与 `revision`。
3. 简单操作用 `cell` / `slide`；多步操作用 `apply --dry-run` 检查最终文档。
4. 携带读到的 `--revision` 保存，检查退出码。冲突后重新读取、调整操作，不盲目覆盖。
5. 需要验证 Python 时显式执行 `run`，然后用 `runtime` 读取变量、依赖图或输出。
6. CLI 保存后刷新浏览器查看。浏览器若有未保存修改，先完成保存；CLI 不会把修改推送到已打开的页面。

CLI 编辑走与浏览器相同的校验、版本检查和原子保存接口。一次 `apply` 中任何操作失败都不保存；成功时只保存一次。修改不会自动执行 Python，也不加入浏览器的 Ctrl+Z 历史。重要修改前可以导出完整文档作为备份。

## 3. 命令速查

| 命令 | 用途 |
| --- | --- |
| `status` | 服务地址、当前笔记路径、revision 和结构摘要 |
| `list [--query 关键词]` | 工作区笔记列表；`kind=marimo` 仅用于发现，不能用本 CLI 编辑 |
| `create --title 标题` | 新建空白笔记，返回路径及第一页 ID；不会自动切换后续命令的目标 |
| `show [--summary] [--slide ID \| --cell ID]` | 读取全文或指定对象；摘要省略源码 |
| `rename 标题` | 修改笔记标题 |
| `slide add --name 名称 [--id ID] [--before ID]` | 添加页面；省略 before 追加到最后 |
| `slide update --id ID --name 名称` | 页面改名 |
| `slide move --id ID [--before ID]` | 页面排序；省略 before 移到最后 |
| `slide delete --id ID` | 删除页面及其 cells；不能删除最后一页 |
| `cell add --slide ID --kind python\|markdown --source-file 文件` | 添加 cell；可指定 `--id` / `--before` |
| `cell update --id ID --source-file 文件` | 更新源码；也可只更新 display / show-code |
| `cell move --id ID --slide 目标页面ID [--before ID]` | 跨页或同页移动；移动的 cell 恢复默认整行布局 |
| `cell delete --id ID` | 删除 cell |
| `apply --file 操作文件` | 批量编辑，一次保存 |
| `replace --file 文档 --revision 版本` | 完整文档替换；revision 必填 |
| `validate [--file 文件]` | 校验笔记结构；本地文件校验无需启动服务，不检查 Python 语义 |
| `run [--cell ID] [--force] [--control KEY VALUE]` | 执行代码或改变滑杆值 |
| `runtime [--view 视图]` | 只读上次运行快照，不执行 Python |
| `interrupt` | 停止并重置目标笔记的 Python 内核 |

`rename`、`slide`、`cell`、`apply` 支持 `--revision` 和 `--dry-run`；`replace` 支持 `--dry-run`。预览输出包含完整修改后文档，`revision` 仍为当前保存版本。

ID 使用字母数字，区分大小写；页面和 cell 的 ID 在整本笔记内唯一。不要用页面序号或标题替代 ID。添加时省略 ID 可自动生成，返回的 `operations[].id` 可用于后续命令。批量中需要引用新对象时，直接给它指定 ID。

## 4. 源码与展示方式

多行 Python、Markdown、公式使用文件或带引号的 heredoc，避免 shell 展开 `$`、反引号：

```bash
# 把 PAGE_ID 换成 show 输出中的页面 ID。
./notes cell add --slide PAGE_ID --id explanation --kind markdown --source-file - <<'TEXT'
## 一个二元函数

$f(x_1,x_2)=x_1^2+x_2^2$
TEXT

./notes cell add --slide PAGE_ID --id calculation --kind python --source-file - <<'PY'
def f(x1, x2):
    return x1**2 + x2**2

f(1, 2)
PY

./notes cell update --id calculation --display fragment --show-code false
```

- `--display slide`：随页面直接显示，对应文件中的 `normal`。
- `--display fragment`：放映时逐步显示。
- `--display skip`：放映隐藏，但 Python 仍参与计算。
- `--show-code true/false`：是否在放映时展示 Python 源码。
- `--source` 适合短字符串；`--source-file -` 从 stdin 读取。
- `cell update` 不改变 cell 类型。需要转换时新增目标类型后删除原 cell。

浏览器内跨页复制：在 cell 的 `⋯` 菜单选择“复制 cell”，切换到目标页，在插入位置的 `＋` 菜单选择“粘贴 cell”；相邻 cell 的 `＋` 菜单也可向下或向右粘贴。副本使用新 ID，保留类型、源码、放映设置和代码折叠设置；不会复制 Python 运行结果。插入空行时使用目标页的默认布局，相邻粘贴时使用目标列布局。此 cell 剪贴板保存在当前工作台窗口中，刷新后清空。

### HTML cell

`cell add --kind html` 可保存完整 HTML 文档或 HTML 片段，支持其中的 CSS、SVG、Canvas 和 JavaScript。浏览器的“＋”菜单也可新增 HTML。源码使用 HTML 高亮；点击“渲染 HTML”或 Shift+Enter 重新加载预览。浏览器内交互不请求 Python，适合实时拖动演示。

```bash
./notes cell add --slide PAGE_ID --kind html --source-file /tmp/demo.html
```

每个 HTML cell 在独立的 sandbox iframe 中执行脚本，不能访问笔记工作台的 DOM、Cookie 或本地存储；预览自动适应内容高度。HTML cell 不参与 Python 依赖图，`run --cell` 仍只接受 Python cell。普通 `mo.Html` 继续使用原有的无脚本过滤规则。

同一页的多个 HTML cell 可使用注入的 `noteHtml` 接口共享 JSON 状态：

```javascript
noteHtml.subscribe("demo", state => { /* 根据 state.a 更新图或控件 */ });
noteHtml.init("demo", {a: 0.6, N: 2}); // 仅补充尚未设置的字段
noteHtml.setState("demo", {a: 1.2}); // 合并部分字段并通知所有订阅者
```

`subscribe` 返回取消订阅函数，新订阅者会立即收到当前状态；首次为空对象，渲染时需提供默认值。状态按 Workspace、笔记路径、页面和通道名隔离，保存在当前浏览器工作台会话中，刷新后恢复代码中的默认值。通道名以字母开头，只包含字母、数字、下划线和连字符，最多 80 字符；每个通道状态最多 64 KiB、每次更新最多 80 个字段。回调中不要无条件调用 `setState`，以免制造消息循环。

Python、Markdown、HTML 可使用相同的 `layout.row` / `column` 并排或上下排版；Python 通过依赖图重算，HTML 通过浏览器事件更新。两种运行环境不共享变量，`noteHtml` 只联动 HTML cells，不会执行 Python。

## 5. 批量编辑与并排布局

`apply` 输入是 JSON **操作数组**。以下例子可保存为 `/tmp/changes.json`；运行前先确认这些 ID 尚不存在：

```json
[
  {"op":"slide.add","id":"demo","name":"函数实验"},
  {"op":"cell.add","slide":"demo","id":"explain","kind":"markdown","source":"## 解释\n\n$f(x)=x^2$"},
  {"op":"cell.add","slide":"demo","id":"compute","kind":"python","source":"x = 2\nx**2","showCode":true},
  {"op":"cell.update","id":"explain","layout":{"row":"demorow","x":0,"width":40}},
  {"op":"cell.update","id":"compute","layout":{"row":"demorow","x":40,"width":60}}
]
```

```bash
./notes apply --file /tmp/changes.json --dry-run
./notes apply --file /tmp/changes.json --revision READ_REVISION
```

`READ_REVISION` 替换为 `show` 或预览中的 revision。也可 `apply --file - <<'JSON'` 直接传入数组。

操作字段（未列出的字段会报错，避免拼写错误静默失效）：

| op | 字段 |
| --- | --- |
| `notebook.rename` | `title` |
| `slide.add` | `name`；可选 `id`、`before` |
| `slide.update` | `id`、`name` |
| `slide.delete` | `id` |
| `slide.move` | `id`；可选 `before` |
| `cell.add` | `slide`、`kind` (`python`/`code`/`markdown`)；可选 `id`、`before`、`source` 或 `sourceFile`、`display`、`showCode`、`layout` |
| `cell.update` | `id`；可选 `source` 或 `sourceFile`、`display`、`showCode`、`layout` |
| `cell.delete` | `id` |
| `cell.move` | `id`、`slide`；可选 `before` |

`sourceFile` 读取本地 UTF-8 文件，不支持 `-`，路径按 CLI 当前工作目录解析。`source` 与 `sourceFile` 不能同时提供。`before` 必须指向目标列表中已有对象，省略或 `null` 表示末尾。

并排 cell 必须位于同一页面且在列表中连续，使用相同的字母数字 `layout.row`。每行最多 4 列；同一列的 cell 在列表中连续并共享字母数字 `layout.column`，省略 column 则每个 cell 独立成列。各列内部可以有多个 cell。`x` 和 `width` 是百分比：宽度至少 20，`x + width <= 100`，同一列共享 x/width，不同列的区间不要重叠。列顺序按 x 递增，列内按从上到下排列。设 `snapLeft:false` / `snapRight:false` / `snapTop:false` / `snapBottom:false` 可独立解除对应边界吸附，缺省为开启。可选 `y` 是相对于本 cell 在列内自然起点的额外留白（0–10000 像素；首个 cell 从行顶部算，后续 cell 从上一块底部加 `gapBefore` 算，缺省间距 24px）；`height` 是最小高度（62–10000 像素），内容超过时自动撑开；省略则自动高度。可选 `gapBefore` 为同列上一块底部到本块的基础间距（0–1000000 像素），用于保存拖动后的独立位置；实际间距为 `gapBefore + y`。六点拖动默认支持同列上下排序，无需 Shift；拖动过程中其他块保持原位，越过目标中线显示插入位置，松手才改变顺序。空隙内微调会补偿下方间距，保持其他块原位。不会触碰推动。上下边界吸附其他列 cell 的上下边界及本 cell 的自然起点。窄屏堆叠时暂不应用 `y`，不会改写保存值。`layout:null` 移除该 cell 的布局。不要为了修改一个 cell 重建整页，否则容易丢失其他 ID 或布局。

## 6. 运行、变量、依赖图

```bash
./notes run
./notes run --cell calculation
./notes runtime --view variables
./notes runtime --view graph
./notes runtime --view errors
./notes runtime --view outputs
./notes run --control 'parameters:x1' 1.2
./notes interrupt
```

`run` 复用服务器内核，执行修改过的 cell 及其下游；首次运行会计算必要的所有 cell。`--cell` 额外重算指定 cell 及其下游，**不是只执行那一个 cell**。`--force` 重算全部。控件 KEY 从 `outputs[cellID].controls[].key` 获取，先运行创建控件再修改值。参数值只保存在会话内，不修改源码中的默认值。

`run` / `runtime` 都支持 `--view summary|all|outputs|variables|graph|errors`。默认 summary 保留文本输出、错误、变量、控件与执行耗时，仅省略 Plotly 的大体积 figure；`--view all` 获取完整状态。graph 返回 nodes（每个 cell 的 inputs/outputs）及带变量名的 edges。

`runtime` 不执行代码，首次运行前或 interrupt 后 `state=null`；`running` 表示正在计算，返回的仍是上一次完成的结果。`executedRevision` 是结果对应的文档版本，`stale=true` 表示尚无结果或笔记已改变；此时不要把旧输出当作当前验证结果。运行错误也在快照中保留，查看错误本身退出码为 0。

Python 在本机执行，工作目录为服务 workspace。不同笔记使用独立内核，同一笔记的浏览器和 CLI 共用内核。服务端单次执行上限为 20 秒。CLI 的 Ctrl+C 中断等待；已提交的计算使用 `./notes --notebook 路径 interrupt` 停止，或在服务终端 Ctrl+C 停止全部。

## 7. 导出、整本替换、返回值

`show` 默认返回 `{ok,path,revision,document}`，导出时提取 document：

```bash
./notes show > /tmp/note-snapshot.json
.venv/bin/python - <<'PY'
import json
from pathlib import Path
snapshot = json.loads(Path('/tmp/note-snapshot.json').read_text())
Path('/tmp/note-document.json').write_text(json.dumps(snapshot['document'], ensure_ascii=False, indent=2))
print(snapshot['revision'])
PY
./notes validate --file /tmp/note-document.json
# 修改文档后，用上一步读到的版本替换：
./notes replace --file /tmp/note-document.json --revision READ_REVISION --dry-run
```

所有正常操作 stdout 为 JSON；失败信息为 stderr JSON，帮助文本除外。代码执行返回 cell 错误时，结果仍在 stdout，`ok=false`，退出码 4，便于保留 traceback 继续 debug。

| 退出码 | 意义 |
| --- | --- |
| 0 | 命令成功；runtime 只表示读取成功，不表示代码无错误 |
| 1 | 网络或服务错误 |
| 2 | 参数、操作或本地文档错误 |
| 3 | revision 冲突；重新读取后处理 |
| 4 | Python 运行完成但存在 cell 错误 |
| 130 | 用户中断 CLI |

## 8. 可运行示例

仓库提供 `src/slide_notes/examples/agent-demo.operations.json`，包含函数定义、Markdown 公式、两个滑杆和 Plotly 曲面。建议新建笔记尝试：

```bash
./notes create --title 'Agent 函数实验' > /tmp/agent-created.json
export SLIDE_NOTES_NOTEBOOK="$(.venv/bin/python -c 'import json; print(json.load(open("/tmp/agent-created.json"))["path"])')"
./notes apply --file src/slide_notes/examples/agent-demo.operations.json --dry-run
./notes apply --file src/slide_notes/examples/agent-demo.operations.json
./notes run
./notes runtime --view graph
./notes run --control 'agentparams:x1' 1.2
unset SLIDE_NOTES_NOTEBOOK
```

示例在空白第一页之后新增“函数实验”，浏览器 Files → 仅笔记打开新笔记，再选择该页。示例使用固定 ID，不能在同一本笔记重复 apply。运行前可查看操作文件中的完整源码。

## 9. marimo 控件与跨 cell 联动

现已接入真实 `import marimo as mo` 对象，支持常用输入控件、`mo.md` / `mo.Html`、`mo.vstack` / `mo.hstack` 和 `mo.ui.plotly` 的选择事件。控件创建在 Cell A，Cell B 读取 `.value`；控件变化只重算读取者，不重建创建者。

参见 [mo 使用与边界](mo.md)，以及 `examples/mo-linked.json` / `examples/mo-selection.json`。`run --event KEY JSON` 可从 CLI 发送布尔、选项数组、文本或图表选择事件；数值仍可用 `--control KEY VALUE`。KEY 从 `runtime` 的 `state.outputs[ID].result.widgets` 获取，每次重建控件后重新读取。不要默认全部 marimo API 都已支持。

## 多工作区与真实目录（0.2）

安装后的命令是 `slide-notes-agent`；开发目录仍可用 `./notes`。新版先 `workspace list` / `workspace open /绝对路径` 获取 ID；后续所有笔记请求加 `--workspace ID`，或设置 `SLIDE_NOTES_WORKSPACE`。多个工作区时不能省略 ID。只读环境状态用 `workspace environment`，失败后 `workspace initialize` 重试。首次 open/create 会后台初始化环境，不会执行笔记代码。

```bash
./notes workspace create /tmp/new-notes-workspace
./notes --workspace ID workspace environment
./notes --workspace ID files mkdir notebooks/课程
./notes --workspace ID create --title 函数 --directory notebooks/课程
./notes --workspace ID files list --notes-only
./notes --workspace ID files impact notebooks/课程/函数.json
./notes --workspace ID files move notebooks/课程/函数.json notebooks/课程/曲面.json --revision 上一步的文件版本
./notes --workspace ID files copy notebooks/课程/曲面.json notebooks/课程/曲面.json --revision 复制前的文件版本
./notes --workspace ID files impact notebooks/课程/曲面.json
./notes --workspace ID files trash notebooks/课程/曲面.json --revision 上一步的文件版本
./notes --workspace ID files trash-list
./notes --workspace ID files restore 返回的回收项ID
```

文件 impact revision 和文档 show revision 是不同版本，不能互换。move/copy/trash 必须显式提供文件版本，不自动重试冲突。copy 自动给重名副本加编号，可在原目录内复制，保留源码与原笔记的独立保存状态。文件夹 impact 包括其中所有普通文件；删除前检查 `otherFiles`。笔记模式只是投影，不隔离隐藏文件。移动会同步当前服务中的路径和内核，正在计算则拒绝；恢复不会覆盖已有同名文件。CLI 修改后浏览器刷新。仅笔记目录保留空文件夹，便于创建新笔记。

新版 Workspace 初始化返回 `notesDirectory`（默认 `notebooks`）及 `notebookAliases`（迁移映射）。`list` 和 `files list --notes-only` 只查专用目录，返回路径仍相对 Workspace；`create` 不指定目录即创建到专用目录，显式 `--directory` 必须在其中。已有自制笔记升级时自动迁移；重新 list/show 获取实际新路径。

浏览器 Files 目录树支持方向键导航：↑/↓ 移动，→ 展开或进入子项，← 折叠或返回父项，Home/End 到首末项，输入名称前缀定位，Enter/空格打开或切换展开。F2 重命名、Delete 移到回收站、Shift+F10 打开右键菜单。方向键不会打开或运行笔记，也不会触发放映翻页快捷键。

系统文件或文件夹可拖到目录行、文件行（放入其父目录）或目录树空白处（放入当前视图根目录）。工具栏“导入文件”和目录右键“导入文件夹”提供文件选择器；在目录树聚焦时，Ctrl+V 导入浏览器剪贴板提供的文件。目录结构及拖入的空目录会保留，同名导入自动编号，单文件上限 100 MB。上传按二进制流处理，未完成上传不会发布目标文件；不会覆盖打开的笔记或删除外部原文件。仅笔记视图导入后自动切换为工作区文件。

选中目录树项目后 Ctrl+C / Ctrl+X，聚焦目标目录后 Ctrl+V；右键也提供复制、剪切、粘贴。剪切项显示为淡色，Esc 取消。复制保留原文件，剪切在工作区内移动并同步打开标签及笔记保存位置；Ctrl/Alt 拖拽在工作区内复制。文本编辑器和搜索框保留文本剪贴板行为。普通浏览器不能保证系统文件剪贴板双向互通：若外部粘贴只给出路径而没有文件内容，会提示使用拖入或文件选择器。

向系统拖出通过浏览器 DownloadURL 协议导出文件，目录导出为 ZIP；支持情况取决于浏览器与系统文件管理器，可使用右键“导出文件/导出文件夹（ZIP）”下载。协议依据：[Chromium/Edge DownloadURL explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/DownloadURL-list/explainer.md)。实际系统文件管理器落盘未在无桌面的测试环境验证；回归测试验证了浏览器拖出载荷、真实二进制下载和 ZIP 内容。新增接口遵循现有同源、显式 Workspace 及保留目录限制，不读取或导出符号链接目标。

目录树工具栏提供“定位当前文件”“全部折叠”和“自动定位当前文件”。自动定位默认开启，按工作区记忆开关，切换编辑器时展开父目录但不抢走编辑器焦点；搜索时保持搜索条件，手动定位会清除搜索。“仅笔记”模式不能定位专用目录以外的文件，可切换“工作区文件”。后台刷新保留目录树焦点和滚动位置。本机分析记录不随公开源码导出；浏览器回归测试为 `npm run test:file-tree --prefix frontend`。

“工作区文件”默认开启“隐藏配置文件”，开关位于目录树工具栏并按 Workspace 记忆。目录树与搜索一起隐藏项目配置、依赖、缓存、内部会话，以及自制笔记源码工作区中的软件入口、源码和构建目录；保留整个 `notebooks`、已有论文/图片/资料目录与普通内容文件。关闭开关恢复全部文件，隐藏不会删除文件或改变 CLI、Agent 的访问权限。“仅笔记”继续使用原有投影，此开关在其中不可用。

界面/CLI 创建、导入、复制、移动、恢复，以及 Agent 写入或保存生成的内容，都会在 `.slide-notes/user-files.json` 记录用户文件路径。记录随移动更新并跨重启保留；用户显式添加的配置同名文件不会因名称被误隐藏，其必要父目录也会显示。对功能上线前已有文件，依据常见配置名和软件目录识别，不以未知扩展名删除或排除用户资料。显示 API 可显式加 `content=1` 到 `/api/files`、`/api/search`；默认 API 与 CLI 保持完整目录语义。验证见 `test_workspace_visibility.py` 与 `test_file_transfer.py` 的浏览器开关、搜索及持久化测试。

## 公式之间的悬停联动

Markdown 公式可用 `\htmlData{math-link=分组ID}{公式片段}` 标记对应关系。同一页面内，悬停任意片段，所有相同分组 ID 的片段同步高亮，离开后恢复；支持跨 cell，编辑与放映模式都生效，不执行 Python。

例如左侧 `$\htmlData{math-link=example-g}{g_{k+1}}$`，右侧 `$\htmlData{math-link=example-g}{g_{k+1}=\partial V_{k+1}/\partial x}$`。分组 ID 以字母开头，只能包含字母、数字、下划线和连字符，最多 80 个字符。不同推导使用不同分组 ID。此功能只允许 `math-link` 属性，新 Markdown 引擎将该旧标注适配成安全 MathJax 类，不依赖旧 KaTeX 渲染或公式片段编辑。

## Plotly 图下的步进控件

有限步数演示可使用原生 `note.slider`，并在 Figure 中声明步进展示；无需额外控件 cell：

```python
k = int(note.slider("Forward rollout", 0, 8, step=1, value=0, key="k"))
# 按 k 构建 fig；下游 cell 可引用 k 展开公式。
fig.update_layout(meta={"noteControls": {"style": "stepper", "position": "bottom"}})
fig
```

前端显示“下一步”、重置和可拖动的进度条，步长沿用 slider 的 step。每次事件重算当前 cell 和下游；显示顺序不影响依赖顺序，因此公式 cell 可在图形 cell 左侧。控件仍通过 runtime 的 `controls[].key` 和 `run --control` 验证。此配置只作用于声明了该 metadata 的普通 Plotly Figure。


## Workspace Agent

AI 对话的工具范围是当前 Workspace，当前文件/cell 只是默认上下文；没有打开文件也能开始对话。软件、应用配置、原版入口和 `idea.md` 保持只读。可用工具：

- `list_workspace`、`search_workspace`、`read_file`：目录分页、文件名/文字检索、带行号的文本读取；不越过工作区，不通过符号链接读取，不读取内部配置/会话目录。
- `read_pdf`、`search_pdf`、`read_image`：读取任意 PDF 页、全文检索和图片像素。PDF 用本机 Poppler，文本每次最多5页，显式带图像最多3页；扫描页自动附图。支持 `nextPage`、页内文字偏移，不需要用户翻页。没有打开的 PDF 也可通过 Workspace 相对路径读取；不会导航用户的阅读器。
- `inspect_note(path)`、`apply_note_operations(path,revision,operations)`：跨笔记读取与原子编辑；目标须在专用笔记目录。省略 path 保留当前 cell/多选范围语义，指定 path 操作目标笔记。写入前先读取最新 revision，经原有编辑器同步、保存与撤销流程。
- `create_note`、`write_text_file`、`manage_files`：创建笔记/Markdown/文本/数据文件，建立目录，按 impact revision 移动/重命名、移到回收站及恢复。普通提问不应写入；只有用户要求整理或修改时执行。不会覆盖目标或删除软件目录。
- `run_command`、`save_generated_file`：Shell/Python/NumPy 等计算在 Linux Bubblewrap 命名空间中执行。Workspace 只读挂载，用户主目录和网络不可访问，继承环境清空，内部配置目录被遮蔽；运行库单独只读挂载。在 `/scratch`（`NOTE_OUTPUT_DIR`）生成文件，再由保存工具导入 Workspace，不绕过 JSON 笔记保存接口。单命令最长60秒，限制内存、CPU、进程、输出和临时盘大小；取消/超时终止所拥有的隔离进程。沙箱不可用时报错，不退回无隔离执行。笔记的原生 Python 内核不会被这些计算更新。生成文件每个最多3 MB、每次最多16个、合计8 MB；导入不覆盖已有文件，JSON 数据只导入笔记 assets 目录。

Agent 可连续调用工具完成任务，每轮最多16个模型步骤、48次工具调用，读取数据和图像有总量上限。回复下方可展开“已使用 N 项工具”，查看读取页码、保存路径和命令输出。小型工具轨迹保存在消息与分支中，下一轮“继续”会携带上次阅读位置和生成文件引用；原始页面像素、完整文件和终端数据不重复写入历史。

验证：`test_ai_workspace_tools.py` 使用临时 Workspace、真实 Poppler/Bubblewrap 验证路径隔离、PDF 读取、NumPy、产物导入和超时；`test_ai_workspace_browser.py` 用真实 Chrome 与模拟服务验证无活动文件时读取 PDF、创建笔记、跨笔记修改、重命名、计算与保存产物的完整流程；`test_ai_claude.py` 使用假的 CC 可执行文件验证工具与图像协议。测试不调用真实模型、不修改用户笔记。

PDF 主页面发起 AI 对话时，自动将发送时当前页注册到 Workspace 的 `sessions/pdf-context/` 缓存，消息只保存 `pdfContext={id,path,page,pageCount,fingerprint}` 引用。同一打开的 PDF 页面按页码、指纹、旋转复用缓存，不重复截图或上传，也不显示自动 PDF 附件卡；重新打开 PDF 可再次捕获，相同内容复用磁盘文件。当前页的文字和一份截图统一注入模型上下文，历史不同页文字去重后保留，不重传历史自动截图；旧版 `sources.kind=pdf-page` 也会去重。手动选区优先且仍显示附件卡。不整份上传 PDF；无文字页面使用截图。页面未加载完成时保留草稿，文件更新需重新打开，原始 PDF 只读；`inspect_note` 可读取当前页快照。CC 仍是逐轮 print-mode 调用，必要页面内容每轮进入上下文，不代表原生持久会话或零 token。

AI 回答随 SSE 增量实时渲染 Markdown、表格、Prism 代码和 MathJax 公式；支持 `$...$` / `$$...$$` / `\(...\)` / `\[...\]`。未闭合公式先显示“公式生成中…”，停止后保留未完成源码；不改写保存的消息。历史消息和未变化的段落保留 DOM，用户向上滚动时不强制跳回底部。“修改建议”保持生成后审阅流程。回答暂用16px衬线字体、1.65行距，代码13px等宽字体；Claude 网页被访问验证拦截，字体尚非实测。独立检查：`npm run test:ai-response --prefix frontend`。

## Obsidian 式 Markdown 单元格

默认使用实时预览，光标/选区所在结构显示 Markdown 源码，其他位置渲染。单元格模式按钮提供“实时预览 / 源码模式 / 阅读视图”；Ctrl+Q 切换实时预览与源码，Ctrl+E 切换阅读与编辑，Shift+Enter 插入换行。模式是工作区/笔记/cell 的本机视图偏好，不写入笔记文档；放映强制阅读显示。源码始终是唯一内容，编辑和任务勾选通过原有版本保存与撤销流程。

样式以本机 Obsidian 1.14.4 默认浅色主题为依据：系统 sans 字体栈、正文16px、行距1.5、代码14px、六级标题比例、列表/引用/表格/Callout/高亮排版。公式使用离线 MathJax CHTML；代码使用 Prism，Mermaid 随桌面包离线提供。解析采用 unified/remark/mdast/hast；原 Marked 渲染和 KaTeX 字形片段编辑已移除，JSON笔记结构无需迁移。

块公式兼容 `$$公式$$`、独立行 `$$` 和 `$$\begin{aligned}` 同行开始/结束的写法；行内公式仍使用单个 `$`。Markdown 内容使用单元格的实际宽度及24px内边距，块公式居中，超宽公式在自身区域横向滚动，适用于并排单元格；不需要改写既有公式源码。

实时预览中，块公式显示彩色 TeX 源码并在下方同步显示排版结果。文字与单 `$` 行内公式混合的段落只有一层：正文始终留在原生编辑器中；段落未进入编辑时，公式原位置排版；进入混合段落或标题后，其中全部行内公式统一显示彩色 TeX 源码，整段成为连续的原生编辑和选取表面，不重复整段预览，也不保留不可编辑的行内公式岛。源码模式保留公式语法高亮，不显示排版预览。预览不插入文档内容，公式修改仍使用原生编辑器撤销。

混合段落的文字和彩色 TeX 使用 CodeMirror 原生鼠标选区处理，保留字符亲和性、换行、按词选择、Shift 扩选和已有选区拖动行为；仅在按下已编译的公式字形时使用 MathJax 的 UTF-16 源文位置适配器，区分重复符号。鼠标按住期间固定公式替换和 Markdown 标记的布局，松开后才按最终选区更新显示。支持由文字或公式开始的拖选、反向拖选和 Shift 点击扩选；不是用屏幕高度估算中文段落的行号。 渲染块在确认单击后才展开，拖动、双击和已有浏览器文字选区不作为单击触发展开；下一次手势取消待执行的展开。块公式支持按符号连续拖选，拖选过程中显示填充选区，松开后将所选源码展开供复制或编辑。符号之间的空隙按实际字形边界定位，不采用覆盖整条公式的容器起点。字形几何在一次手势内复用，高亮只更新变化的符号，避免反复清除已有选区。跨平台鼠标与输入法行为需在目标浏览器上验证；本机分析记录不随公开源码导出。

编辑独立块公式时，光标处的符号或结构在下方预览中显示橘黄色填充高亮；选中一段源码则标出对应的多个符号。关联使用 MathJax 解析时记录的源文位置，可区分重复符号、上下标与矩阵项；移动光标不重新排版、不写入笔记，离开公式清除高亮。

支持普通 Markdown/GFM 表格、删除线、任务、脚注（含行内脚注）、`[[笔记|名称]]`、`![[图片.png|320x180]]`、`>[!tip]+ 标题` 可折叠 Callout、`==高亮==`/颜色emoji、`%%隐藏注释%%`、`#标签`、`^块ID`、数学和 Mermaid。Wiki 笔记名可以匹配 Workspace 中自制笔记的标题/文件名；同名时需给出路径。`[[笔记#标题]]` / `[[笔记#^块ID]]` 定位到对应 cell。显式笔记/PDF 嵌入在当前 Workspace 读取，笔记嵌入不获得修改原笔记的权限；不递归展开嵌套嵌入，不加载 Obsidian vault 或社区插件。

任务点击只替换所属方括号中的一个字符，检查原始内容；源码变化后的旧预览、放映视图和只读嵌入不能写入。实时预览中的复杂结构（表格/Callout/代码/数学）在活动时显示其源结构；普通点击进入编辑，Ctrl/Cmd 点击链接打开来源。复杂块定位按源行和点击词估计，重复词不保证精确到同一字符。阅读、打印共用新渲染器；查看笔记不会触发 Python 或 AI。

核心浏览器检查：`npm run test:markdown-browser --prefix frontend`；真实临时工作区的保存/撤销/放映/打印：`node --test tests/frontend/test_obsidian_app.cjs`。后者需要 `.venv` 中现有 Playwright、本机 Chrome 与 socket 权限。包含 iLQR Cell 05 整段与用户提供的混合标题样例，验证原生 DOM 选区字符串、复制、正反向拖选、编辑/撤销，并对截图像素检查可见选区；不仅检查 state.selection 的内部位置。重新构建：`npm run build:markdown --prefix frontend`、`npm run build:editor --prefix frontend`、`npm run build:assets --prefix frontend`。


笔记正文左上角的目录按钮控制当前笔记的页面目录；不属于 Workspace 工具栏。展开/收起偏好按 Workspace 和笔记路径分别保存在本机，切换、重新打开或刷新时恢复；移动或重命名笔记时同步迁移该偏好。PDF、图片和无笔记页面不显示此控件，不修改笔记内容。


AI 输入框的「+」直接开启选取，重复点击或 Esc 完成。笔记中拖框选中所有接触到的 cell，单点可增选/取消，滚动边缘可继续框选；附件保存 cell ID，选取完成即冻结源码快照，发送时使用该版本的引用；agent 可按需读取原文或最新版本。PDF 拖框或单点自动把原文加入发起选取的对话，支持跨页，保存 `kind=pdf-elements`、页码、文件指纹、PDF 页坐标 `rects` 和 `elements=[{index,from,to}]`；index 是 PDF.js `getTextContent({disableNormalization:true})` 过滤仅含 `str` 的文字项后的零基序号，from/to 是该项 UTF-16 偏移。点击附件可返回原文位置。框选不生成、上传截图；扫描页没有文字层时给出提示，可手动粘贴图片。旧截图附件仍可查看和定位。


## 选区引用与按需读取

框选/单点选取的 cell 在本地保存冻结快照；PDF 选区也在加入草稿时注册原文快照。`sources.kind=selection-ref` 记录 `{id,path,targetKind,sourceRevision,text,characters,truncated,stale,...定位信息}`，其中 text 最多600个 Unicode 字符，小选区直接附完整内容。正文保存到 Workspace 的 `sessions/selections/`；笔记文档按版本共享 `sessions/selection-documents/` 快照。会话、分支和浏览器草稿保留引用；同一引用的预览在每轮模型上下文中仅出现一次，PDF 几何坐标不重复放进模型消息。

- `POST /api/ai/selections`：`{selections:[...]}`，每次最多20项，返回 `{sources:[selection-ref,...]}`。笔记整 cell 使用 `{kind:"note-cells",path,cells:[ID],revision?}`；文字片段使用 `{kind:"cell-text",path,cell,text,from,to,textKind:"source"|"rendered"}`；PDF 使用已有 text/pdf-elements 原文定位。新版 PDF 另带载入时 SHA-256 sourceRevision，注册时核对，防止文件已变化而文字层仍旧。
- `read_selection(id,path?,version?,offset?,limit?,before?,after?)`：默认 snapshot 读取冻结内容；latest 读取最新笔记。返回 revision/currentRevision、stale、selectionAvailable、text、parts、nextOffset。原 cell 删除时 snapshot 可读；latest 明确报告 missingCells。渲染文字的 from/to 不当作 Markdown 源码偏移，snapshotAligned 指示原文范围是否可可靠对应。
- limit 默认8000，最多16000；offset/nextOffset 为工具返回文字（含位置标题）的 Unicode 字符偏移；源码 from/to 仍为 UTF-16，不能混用。before/after 各0–2，笔记展开相邻 cell，PDF 展开相邻页。PDF 上下文只提取文字，不自动生成图像；超长页通过 pageContinuations 提示再用 read_pdf(textOffset) 续读。
- PDF 文件变更后，snapshot 保留原选区；latest 不套用旧元素位置，应重新选取或 read_pdf 按页读取最新文件。旧文件变化或删除时，相邻页原版本无法恢复，会明确标记 contextUnavailable。
- 普通对话用预览和工具按需展开。无工具的“修改建议”模式附完整的有界选区文本；过大时明确提示使用普通对话或缩小选区。修改仍须读取最新内容与 revision，遵循原保存工具边界。

测试使用临时 Workspace、真实 Chrome、假 API 与假 CC 可执行文件；不调用真实模型或覆盖用户笔记。
