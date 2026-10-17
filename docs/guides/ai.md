# AI 接入与使用

## 浅色对话界面与笔记模式

界面参考 Claude Code 扩展的欢迎页、紧凑工具栏和底部输入框，使用与笔记兼容的浅纸色背景、橙色焦点边框和模型胶囊。欢迎页的示例只填入草稿，不发送请求；模式说明卡可以隐藏。

输入框底部的 `＋` 继续提供 cell 多选与区域框选；`/` 打开笔记命令（有草稿时显示帮助，不覆盖草稿）。侧栏文件标签默认提及当前主页面文件，随标签页切换更新；点击查看本轮实际上下文。cell 浮窗仍显示固定 cell 范围；显式添加的 cell、文字、PDF/图片选区可以分别移除。切换文件保留同一 Workspace 会话和草稿。

模式菜单提供 **笔记协作 / 修改建议**。笔记协作允许 Agent 按要求操作 Workspace 内的笔记内容、页面、cell、布局和内容文件，通过现有 guard/revision 接口保存；修改建议进入前后对比和人工应用流程。软件源码、应用配置与凭据不属于 Agent 的可写范围，访问不能越出当前 Workspace。“只读”描述的是软件层面，不禁止解析 PDF 或编辑笔记。旧版保存的“仅问答”笔记会话自动映射到笔记协作，保留草稿和历史。PDF/图片的原始内容不直接改写，但可读取、分析，并把结果保存为笔记或内容文件。模式随每个对话保存，分支继承父对话的模式。

底部模型胶囊修改当前对话的模型，不改全局默认配置；Claude Code 可选择默认模型、Sonnet、Opus 或填写账户可用的模型 ID，并选择默认 / Low / Medium / High / XHigh / Max 思考强度（由所选模型与 CLI 决定支持情况）。兼容 API 可填写自己的模型 ID。模型与强度随对话保存；留空使用设置中的默认值，不自动替换成截图所示的模型。

Enter 发送，Shift+Enter 换行；Ctrl+Escape 聚焦/离开当前对话输入框；输入框内 Alt+M 切换模式。回复期间模式、模型控件被禁用，“停止”仍可用。所有样式和交互应用于右侧全局对话与 cell 浮窗，原有笔记格式、选区来源和撤销历史保持不变。

验证：`npm run test:ai-interface --prefix frontend`（真实 Chrome 的 16 个交互场景）。界面实现不装载或分发 Claude Code 扩展的私有源码。本机分析记录不随公开源码导出。聊天请求使用 `permission: "notes-only"` 表示软件层面只读、笔记与 Workspace 内容可操作；旧版的 `edit` / `read-only` 值保留兼容并采用相同边界。

## 使用本地 Claude Code

AI 助手 → 设置，将“服务”切换为 **本地 Claude Code**，保存即可。应用优先查找 PATH 中的 `claude`，也支持 `~/.local/bin/claude`；桌面 App 的 PATH 不包含该目录时仍能发现它。需要手动选择时，填写可执行文件的绝对路径，不填写 shell 命令或附加参数。模型留空使用本地 CC 默认配置，也可填写 CC 支持的模型名称。

Windows 使用原生 `claude.exe`；npm 的 `.cmd` / `.bat` 包装器不作为可执行文件接受。安装原生版本并登录后，Note 会在 PATH 或 `~/.local/bin/claude.exe` 查找，也可在设置中填写绝对路径。

先在终端运行 `claude` 完成登录。Note 复用本机 Claude Code 的登录和服务配置，不导入、回传或另存 CC 的登录凭证，也不会把 Note 保存的 API Key 传给 CC。切回兼容 API 时原有 API 配置保留。“保存并测试连接”仅发送短测试请求，不包含笔记，使用本地 CC 账户的服务额度。本地 CC 指本机运行的 CLI，模型请求仍由 CC 访问所配置的服务，并非离线模型。

支持现有的全局 / cell / 多选对话、明确添加的图片与文档选区、修改建议、分支上下文和 Workspace 工具。CLI 以 safe-mode、空内置工具集、禁外部 MCP 和禁 hooks 方式运行，工作目录是临时空目录；上下文从标准输入传入，Workspace 读取、PDF 解析、笔记保存与隔离计算由 NoteAgent 工具代办，不使用 CC 的原生文件或终端工具。工具调用经过路径白名单、revision 检查和编辑器 guard，成功的笔记修改进入浏览器撤销历史。模型原生推理、调试日志与原始错误不显示到聊天中。

每个结构化轮次完成后正文整段显示，工具读取/保存状态仍通过 SSE 显示。停止会终止本次请求拥有的 CLI 进程，不影响你在终端运行的 CC；超时和失败不会把未完成结果当成成功。对话继续保存在 Note 的 `sessions/`，不通过 CC 的 `--resume` 共享终端对话。需要支持 `--safe-mode`、`--json-schema`、`--input-format stream-json` 的 CLI；本机验证版本为 2.1.284。

分析扩展 2.1.301 的启动、流式传输和权限控制代码后，第一版使用公开 CLI 协议；没有依赖扩展私有的 stdio 权限控制协议。`--bare` 不读取 OAuth 登录，safe-mode 不加载外部 MCP，因此没有用这两者的组合强行复用扩展内部服务。本机分析记录不随公开源码导出。CLI 接口依据：[官方 CLI reference](https://code.claude.com/docs/en/cli-reference)、[Programmatic usage](https://code.claude.com/docs/en/headless)。

开发验证：`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_ai_claude.py'`、`npm run test:ai-ui --prefix frontend`、`npm run test:ai-settings --prefix frontend`。自动化测试使用模拟 CLI 与临时笔记；真实账户验证只发送无笔记的 OK 测试。

## 配置 GLM 或兼容服务

刷新更新后的应用，点击左侧星光图标 **AI 助手 → 设置**。

- **API Base URL**：智谱官方普通模型接口预设为 `https://open.bigmodel.cn/api/paas/v4`。也可填写其他服务的 Chat Completions 兼容地址，应用自动追加 `/chat/completions`。不要填网页聊天地址；Coding Plan 等专用服务请按相应服务文档填写地址。
- **模型名称**：填写账户可用的模型 ID，例如 `glm-4.7`。不自动选择或切换模型。
- **API Key**：在应用内填写，无需发给开发助手。首次保存后输入框不回显密钥；留空保留当前 Key，“清除 Key”会移除已保存密钥。修改 API 地址时需重新填 Key，避免将原密钥发往另一服务。
- **保存并测试连接**：使用已配置模型发送一次短测试请求，不包含笔记内容；服务可能对此计费。没有真实 Key 时只能验证应用和模拟接口，不能确认具体账户权限或额度。

远程 API 使用 HTTPS；本机 `localhost`、`127.0.0.1`、`[::1]` 服务可使用 HTTP。请求由本地后端发送，浏览器不直接访问模型服务。

协议依据：[智谱对话补全文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)、[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。兼容接口支持标准 `messages`、`model`、`stream`；普通聊天支持兼容 function calling；不发送服务专有参数。

## 两种对话范围

- **Workspace 会话**：右侧 AI 面板的对话属于整个工作区。切换笔记、PDF 或图片保留对话、名称、模型和草稿；输入框底部的文件标签自动提及当前主页面文件，始终显示文件名（所选 cell 另列）。发送时确定本轮默认文件，笔记上下文包含标题、页面名称、cell ID、类型及完整源内容。PDF 可附当前页快照或手动选区，其余页面通过 Workspace 读取工具按需解析；快照尚未就绪时仍可依据文件路径读取。图片可通过选区或 Workspace 图片工具读取。
- **单个 cell**：点击 cell 右上角星光按钮，打开底部独立浮动对话窗口，标题栏支持收起、展开和关闭，点击收起窗口的标题可恢复；关闭只隐藏窗口并保留历史与草稿，仅附带该 cell 的源内容、所属页面与笔记标题。

Workspace 对话通过左侧 AI 助手图标打开，cell 对话通过各自的星光按钮展开，可同时查看。侧栏会话统一保存到 `sessions/workspace.json`，无需单本笔记存在；关闭或删除笔记不删除会话。旧版各文件的 `global.json` 首次读取时合并到新文件，原文件及浏览器记录保留备份，后续不重复导入。cell 浮窗保持明确的单 cell 范围，历史仍保存到 `sessions/<笔记名>-<路径摘要>/cell-<ID>.json`。会话文件随 Workspace 备份，不同浏览器可以读取；保存检查 revision，避免覆盖其他窗口或外部编辑。移动文件会更新会话中的文件引用，不移动 Workspace 会话文件。

顶部单行工具栏左侧是可直接编辑的对话名称；右侧依次为收藏、历史、新对话、设置、关闭。收藏按对话保存，在历史列表优先显示。每个 Workspace 的侧栏、每个 cell 的浮窗分别支持多个独立会话，在历史列表中切换。旧版单会话历史会自动迁移，浏览器原存储保留备份。每轮附带本对话最近 20 条完整消息。每轮默认附带当前提及文件的上下文，历史消息保留各轮当时的文件路径；其他文件不整批附送，Agent 可以按任务调用工具读取当前 Workspace 的笔记、PDF 和内容文件。运行是否过期会作为状态单独附带；可以显式添加 PDF 选区开展跨文档问答。内容只在发送请求或按需工具读取时交给配置的服务。范围内容超过 160,000 字符时会要求改用单个 cell，不静默截断。

点击输入框底部的 **＋** 进入选择状态，直接点击笔记中的一个或多个 cell，选中项会高亮；再次点击取消选择，点击完成图标或按 Esc 结束选择。已选 cell 显示在输入框中，点击标签可移除。选择状态中也可用 Tab 聚焦 cell，再按 Enter 或空格选择。选中后本轮只附带这些 cell 的源内容；未选时 Workspace 对话默认使用当前提及的整本笔记，cell 对话默认使用当前 cell。历史消息仍保留之前讨论的内容。

输入 `/` 在输入框上方弹出可滚动、分组展示的英文命令菜单：`/summarize`（总结）、`/explain`（解释）、`/check`（检查逻辑）、`/improve`（修改建议）、`/help`（命令帮助）。用方向键选择，Tab 或 Enter 补全；完整命令按 Enter 执行，也可在命令后追加要求。

执行 `/help` 后在输入区内显示可滚动的命令列表，点击命令展开用途、用法示例，也可点击“使用此命令”填入输入框。`/help improve` 会直接展开 `/improve` 的说明。帮助在本机显示，不调用模型。

输入后 Enter 发送，Shift+Enter 换行。回复流式显示，可点击“停止”。“新对话”创建独立会话，保留原对话的消息、草稿、名称与已选 cell；历史列表按最近更新时间排列。关闭仅收起对话界面，不删除历史。中断或报错的回复不会作为完整历史继续发送。

## 修改建议与撤销

输入 `/improve`。模型返回建议后点击“查看修改”，比较每个 cell 的修改前后内容，再点击“应用全部修改”。

第一版仅替换现有 cell 的源内容，不改布局、ID、类型，不新增/删除 cell 或页面，不自动执行 Python。建议在后端按请求范围校验；仅能提出对本轮上下文所含 cell 的修改。普通问答不修改笔记；聊天中明确要求修改时，可通过下述笔记 Agent 工具保存。

应用通过原来的保存接口和 revision 冲突检查。若笔记在生成后发生变化，旧建议不会覆盖当前内容，需要重新生成。整批应用是一次浏览器文档历史操作，可 Ctrl+Z 撤销。若应用后保存失败，编辑器保留未保存内容，也可撤销。

## 本地配置与开发验证

Key 保存在应用配置目录 `ai.json`，位置见 [安装与数据目录](workspaces.md)。配置采用原子写入；Linux / macOS 使用仅当前用户读写的 `0600` 权限，Windows 使用当前用户配置目录继承的文件权限。该文件是本机明文配置，不是加密密钥库；不写入工作区、笔记、浏览器 localStorage 或发布包。读取配置的接口返回服务类型、API 地址/模型、`hasKey`、CC 路径/模型及可执行文件检测状态，不返回任何凭证。

同源本机 HTTP 接口（工作台模式携带 `?workspace=ID`）：

- `GET /api/ai/config`、`POST /api/ai/config`：读取公开配置、保存配置。
- `GET /api/ai/context?path=...&scope=cell&cell=...`：只读发送上下文；笔记范围为 `scope=notebook`；多选为 `scope=cells&cells=["id1","id2"]`。
- `POST /api/ai/chat`：请求体包括 `path`、`revision`、`scope`、可选 `cell` 或 `cells`（`scope=cells` 时为 cell ID 数组）、`prompt`、`mode`（`chat` / `suggest`）、`messages`（最多 20 条 user/assistant 消息）和唯一 `requestId`。
- `POST /api/ai/test`：传 `requestId`，不发送任何笔记。
- `POST /api/ai/cancel`：传进行中的 `requestId`。

回复采用 SSE `data:` 事件，类型为 `meta`、`delta`、`tool`、`guard`、`mutation`、`done` 或 `error`。`suggest` 的完成事件包含校验后的 `proposal`，**接口本身不会改笔记**。上游错误响应体不会直接回传，避免暴露凭据。HTTP 重定向不自动跟随。

验证命令：

```bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests/backend -p 'test_ai.py'
npm run check --prefix frontend
```

测试使用临时工作区和本机模拟模型服务，覆盖配置隐藏、权限、流式输出、停止、上下文隔离、过期 revision、修改建议范围、非流式兼容和上游错误。不会使用真实 API Key，也不会发送用户笔记。

图片：全局和 cell 对话输入框支持直接粘贴 PNG / JPEG / WebP / GIF，显示可移除的缩略图；每张最多 3 MB，每条最多 8 张，可只发图片。图片先保存在工作区 `sessions/assets/<sha256>.<ext>`，草稿和历史 JSON 仅保存 `{id,name}` 引用，随备份工作区一起保留；只有点击发送时才发给模型。文字粘贴维持原行为。模型需支持视觉输入。

`POST /api/ai/images` 接收 `{data: "data:image/png;base64,...", name: "截图.png"}`，返回图片引用；`GET /api/ai/images?id=...` 读取本工作区图片。聊天请求及 user 历史消息可带 `images` 引用数组，后端读取本地附件并转为兼容 Chat Completions 的 `image_url` 内容块；本轮含历史最多 32 张图片。

PDF 选区：输入框「+」或阅读器顶部「框选原文」直接进入框选，松开鼠标自动加入发起选取的对话，也可单点选择文字元素、跨页框选；重复点击「+」或 Esc 完成。原生划选文字仍可复制或加入对话。每条消息最多 20 个文档选区，跨页选区整批校验后加入。

PDF 原文快照保存 `{path,page,text,rects,fingerprint,kind:"pdf-elements",elements:[{index,from,to}]}`，会话附件只保存 `sources.kind="selection-ref"` 的 ID、预览和定位：index 是 PDF.js `getTextContent({disableNormalization:true})` 过滤含 str 文字项后的零基序号，from/to 为该项 UTF-16 偏移，rects 为 PDF 页坐标。附件直接携带原文和来源引用，不生成或上传截图；点击附件可回到原文，缩放、旋转和滚动不影响页坐标。扫描页/纯图片区域没有可提取的文字时提示手动截图粘贴；不自动做 OCR。旧图片选区附件仍可查看与定位。

### 按路径解析 PDF

打开 PDF 后可直接发送“继续读后面的页面”“搜索全文的 Bellman equation，并整理成一篇笔记”；也可在任意 Workspace 对话中指定相对路径，例如“读取 `papers/example.pdf` 第 6–10 页”。页面快照和手动选区只是起点，不需要用户逐页翻动。阅读器加载中或快照失败时，消息仍可附上 Workspace 路径，Agent 通过后端读取该文件。

`read_pdf` 支持任意起始页，返回总页数与 `nextPage` 供连续阅读；`search_pdf` 检索指定 PDF 的全文并返回页码，再读取命中页面。每次文字读取最多 5 页，显式附页面图像时最多 3 页，可分批继续。原文件上限 80 MB，页内长文本可继续读取。读取结果可以通过笔记工具新建摘要、整理公式或写入已有笔记；原 PDF 内容不改写。

后端解析需要 PATH 中的 Poppler 命令 `pdfinfo`、`pdftotext`、`pdftoppm`。Ubuntu/Debian 安装方式为 `sudo apt-get install poppler-utils`。扫描页会提供页面图像，图表和公式也可按需附图；所用模型需支持图像输入。不内置 OCR，所以扫描页中的文字不能直接作为全文检索文本。浏览器 PDF.js 阅读与后端 Poppler 解析独立，缺少后端引擎时工具会提示，阅读器仍可打开正常 PDF。

Workspace 会话与文件归属解耦：切换主页面保留同一会话，底部文件提及自动跟随。生成中的请求仍固定使用发送时的文件及 revision；切页只改变下轮默认提及，不把正在执行的写入转向新页面。每轮用户消息保留文件路径；旧修改建议也按生成时的路径检查，须返回原笔记审阅应用。cell 浮窗继续绑定原 cell。PDF 选区加入草稿后才参与发送，不自动调用模型。


## 笔记 agent 的操作边界

Agent 的访问边界是当前 Workspace，可以浏览和检索文件、读取文字及图片、解析 PDF 任意页和全文检索。当前文件、cell 和选区是默认上下文，不限制工具读取其他 Workspace 内容。普通问答只读取；用户要求整理或保存时，可通过 `create_note`、`inspect_note`、`apply_note_operations` 新建或更新专用 `notebooks/` 内的笔记，也可用内容文件工具保存 Markdown、文本、CSV、BibTeX、TeX 等资料并整理目录。

未显式指定目标笔记时，cell / 多选更新仍限于绑定范围内已有的 cell；指定其他目标路径时，先读取该笔记的 revision，再经过编辑器 guard 保存。PDF 对话允许读取任意页、搜索全文、生成摘要笔记和更新其他笔记；“PDF 只读”仅表示不直接改写原 PDF 的内容。需要计算时可调用隔离的 `run_command`，Workspace 挂载为只读，临时输出通过 `save_generated_file` 导入；不开放未隔离的终端、工作区外的文件、软件修改或 API 凭据。具体可用引擎由 `agent_capabilities` 返回；缺少 Poppler 时 PDF 工具会明确提示。

未来语言、快捷键等软件设置需要独立配置接口和白名单，不通过改源码实现。

写入前读取最新 revision，并自动通过 `POST /api/ai/guard` 同步编辑器：保存已有编辑、核对版本，短暂锁住笔记编辑区后才执行后端原子写入。版本冲突、停止或同步超时均不会覆盖内容。`mutation` 返回已保存文档，当前笔记更新并进入 Ctrl+Z 历史；修改其他笔记不切换页面。模型需支持兼容的 function calling；工具循环保留模型所需的 `reasoning_content`，不向聊天界面或历史文件显示这些推理内容。

在 cell 编辑器中选中文字，再点击该 cell 的 AI 图标，草稿会显示可移除的选区卡片；渲染后的 Markdown 文字也支持。发送内容包含 cell ID、原文字、行号（源码选区）和位置快照。选区随草稿/消息保存在 session 文件；打开其他笔记不会改变选区所属文档。后续编辑可能使快照过期，agent 应对照最新笔记确认。


`+` 直接开启上下文选择，无需菜单。在笔记中拖框会选中所有接触到的 cell，单点增选或取消，边缘自动滚动；重复点击「+」或 Esc 完成。选区保留 cell ID，并在选取完成时冻结源码版本；发送时只附预览和引用，agent 按需读取原文或最新内容，不依赖截图。选中状态按文件归属保存，切换主页面保留 Workspace 会话。PDF 框选保存文字元素引用，直接加入当前对话的草稿，只有发送时才请求模型。

选区截图及其预览功能已移除，图片仍可手动粘贴到输入框。旧 `notebook-region`、`image-region`、PDF `region` 附件继续保留历史快照与来源导航。

图片查看：文件区的 PNG、JPEG、WebP、GIF、BMP、ICO、AVIF、SVG 可打开为独立标签页，支持缩放、原始大小、适应窗口、拖动平移和下载，刷新后恢复标签页。打开图片保留 Workspace 会话，并将默认文件提及切到该图片。对话中的图片、PDF 截图和笔记截图可点击放大，在应用内查看并用 Esc 关闭。

`GET/HEAD /api/image?path=...` 只读返回工作区图片，按文件签名校验格式，拒绝越界和符号链接路径；普通图片最大 50 MB，SVG 最大 5 MB，SVG 返回 sandbox CSP 并拒绝实体声明。浏览器无法解码的损坏图片会显示加载失败提示。


图片上下文：可直接粘贴自己截取的图片；打开图片仍将默认文件提及切到原图，agent 可通过 Workspace 图片读取工具访问。旧 `image-region` 保留 `{path,page:1,width,height,rects,fingerprint,image,text}`，仅用于历史附件显示、原图指纹校验和位置回跳，不再创建新的裁剪附件。


## 对话内的修改跟踪

打开笔记对话后，每个会话独立保存内容基线。编辑 cell 后，输入框旁显示“已修改 N 项”；点击可查看前后内容、显示配置和页面顺序变化，以及“你的编辑 / Agent 修改 / 混合修改”来源。Workspace 会话为每个提及文件分别保存基线、所选 cell、来源和待排除差异，切换回来恢复原文件状态；多选 / cell 对话只报告当前范围；加入新 cell 范围会与真正新增 cell 分开标注。已删除的绑定 cell 仍可报告删除，不会获得其他 cell 的编辑权限。

预览中可以取消某项差异：仅不附带它的修改前后记录，当前内容依然按既定对话范围发送。未附的差异会保留，下一轮仍可选择。只有点击发送才调用模型；日常编辑仅在本机比较。后端重新读取已保存的内容并生成带行号的差异，附带 `never-run / running / fresh / stale` 运行状态，不自动读取或发送执行输出。

成功收到完整回复后，基线更新到发送时的内容；生成期间继续编辑的变化留待下一轮。失败和取消不会推进基线。Agent 工具成功保存的内容立即记入对应对话已知状态，在其他已打开的会话中记录为 Agent 修改；来源是本地操作提示，不是不可伪造的审计记录。跟踪开始前的手工编辑无法追溯。

当前文件基线 `changeBaseline`、来源记录 `changeOrigins`、待排除差异 `excludedChanges` 和 `contextPath` 随会话保存，其他已讨论文件的跟踪状态保存在 `fileContexts` 中；每条用户消息的 `changeReport` 保留该次差异。聊天请求可带上述三个字段，SSE 的 `meta.changeReport` 为后端规范化的实际报告，后续历史用户消息可带 `changeReport`。基线最多 220,000 字符，单次差异最多 120,000 字符，单 cell 文本差异最多 16,000 字符；过长报告提示缩小范围，局部截断会明确标记。


## 对话分支

标题栏“新对话”默认从当前会话创建分支，父会话保留，新聊天区不显示旧消息。新分支继承父会话的 cell 范围、修改基线及来源记录，清空输入草稿和待发送附件；历史菜单另有“新建空白对话”，不继承上下文。Workspace 与 cell 对话共用此机制，分支可继续讨论不同文件。

分支创建时冻结可用的已完成消息及更早祖先快照，不包含进行中、失败或取消的回复。顶部“分支自「名称」”可返回父会话，“上下文”可预览继承内容。父会话之后新增的消息、改名不改变已有分支点；分支不复制笔记文件；分支上下文保留每轮当时讨论的文件路径。

继承内容以本机整理的上下文摘录参与发送（最近消息的首尾文字和附件文字提示，最多 12,000 字符，并非模型生成的完整语义摘要）。准确原文保留在冻结的 archive 中，Agent 可用只读 `read_branch_history` 按 offset / limit 分页读取，textOffset 用于长文本续读；section=source / cellSelection 及 attachment 索引可读取历史选区文字。历史图片保留引用，不自动重发像素；需要视觉细节时请明确重新添加图片选区。此工具不读取其他文件，也不增加笔记操作权限。

`branch` 随会话保存在 `sessions/`，包含直接父会话 ID、当时名称、时间、消息数、固定摘录和冻结原文。最多 240 条原文及 1,200,000 字符，超出会提示创建空白会话；现有会话文件 5 MB 上限保持有效。新分支发送只附带摘录与自身消息，不重复附带所有父消息。


### 原文预览与按需读取

大选区在对话中展示最多600字预览，并标明总长度；小选区直接携带全文。完整选区留在当前 Workspace 的 sessions 缓存，agent 可以通过 read_selection 继续读取、展开相邻 cell 或 PDF 页；历史和分支保留引用，不反复携带全部源码。同一引用在每轮模型上下文中只保留一次预览。

框选后继续编辑笔记不会改变已冻结的选区。agent 可选择读取原始 snapshot 或最新 latest；发生变化时会收到 stale 和当前 revision。原 cell 删除仍可读原快照；PDF 更新后不沿用旧元素坐标定位最新内容。来源卡片可返回笔记 cell 或 PDF 原文位置。需要修改时仍按最新 revision 保存。
