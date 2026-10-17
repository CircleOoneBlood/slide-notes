# 在 Slide Notes 中使用 marimo (`mo`)

当前环境使用真实的 **marimo 0.25.1**。自制笔记运行器负责 cell 依赖与调度，桥接层负责 marimo 对象的显示和事件回传，继续使用现有的 Slides、Fragment、Skip 和并排布局。无需启动另一个 marimo 服务。

这是一组经过验证的 marimo 能力接入，**不是完整 marimo 工作台或全部 API 的兼容实现**。原版入口 `./start.sh edit` 仍然可用。

## 启用与示例

更新代码后，在服务终端 Ctrl+C，再运行 `./start-notes.sh`，刷新浏览器。重启会清空运行中的变量和控件会话，保存的源码不会丢失。

仓库提供两本完整示例，可在 Files → 仅笔记中找到：

- `src/slide_notes/examples/mo-linked.json`：一个 cell 放两个滑杆，另一个 cell 绘制曲面和移动点。
- `src/slide_notes/examples/mo-selection.json`：一个 cell 显示 `mo.ui.plotly`，另一个 cell 显示点击、框选或套索选择的数据。

切到“放映”即可只看控件和图像。示例原文件也可以编辑；如需保留模板，先用 Files 新建笔记，再通过 CLI `replace` 导入示例（携带新笔记的 revision）。

## 两个 cell 如何联动

Cell A 创建真实的 UI 对象并输出它们：

```python
import marimo as mo

x1 = mo.ui.slider(-2, 2, step=0.05, value=0.8, label="x₁", show_value=True)
x2 = mo.ui.slider(-2, 2, step=0.05, value=-0.6, label="x₂", show_value=True)
mo.vstack([mo.md("## 调节参数"), x1, x2])
```

Cell B 读取 `.value`，输出图形：

```python
import plotly.graph_objects as go

_height = x1.value**2 + x2.value**2
_fig = go.Figure(go.Scatter3d(
    x=[x1.value], y=[x2.value], z=[_height],
    mode="markers", marker=dict(size=8, color="#4f86ec"),
))
_fig.update_layout(scene=dict(
    xaxis=dict(range=[-2, 2]),
    yaxis=dict(range=[-2, 2]),
    zaxis=dict(range=[0, 8]),
))
_fig
```

首次运行建立依赖。拖动滑杆后，事件更新 `x1.value` 或 `x2.value`，自动重算 Cell B。**Cell A 不会重跑**，所以滑杆不会被重建或跳回初始值。不相关 cell 也不会重算。控件值只是会话状态，刷新页面保留服务里的值；重新运行创建控件的 cell、修改其源码、强制运行全部或重启内核会创建新对象并恢复初始值。

- `import marimo as mo` 在一个 cell 中定义即可；不要在多个 cell 重复定义同名全局变量。
- `x1` 是控件对象，数值是 `x1.value`；与直接返回数值的 `note.slider()` 不同。
- 创建控件与读取其值分放不同 cell。同一创建 cell 内用 `.value` 拼出的字符串不会因该控件事件重新计算。
- 必须把控件放在 cell 最后一个表达式中输出，或放入 `mo.vstack` / `mo.hstack` / `mo.md(f"{控件}")`。只定义不输出不会显示控件。
- 跨页也能建立依赖；Skip 隐藏显示，仍参与计算。
- 所有控件仍遵循 Python 变量依赖，不需要手动连接 UI 元素。

这与 marimo 的“交互更新对象并运行读取者”规则一致，参见 [官方交互说明](https://docs.marimo.io/guides/interactivity/)。

## 当前支持范围

| 功能 | 支持说明 |
| --- | --- |
| `mo.md` | Markdown、公式及内嵌的已注册控件 |
| `mo.Html` | 安全过滤后的普通 HTML，不执行脚本、不嵌入 iframe |
| `mo.vstack` / `mo.hstack` | 控件与文字的纵向 / 横向组合，支持嵌套 |
| `mo.ui.slider` | 数值或 steps 列表，label、disabled、debounce；本项目统一采用横向滑杆并显示数值 |
| `mo.ui.number` | 数字输入、上下限、步长、disabled、debounce |
| `mo.ui.checkbox` | 布尔值 `.value` |
| `mo.ui.dropdown` | 单选；支持标签映射到 Python 对象的 options，Python `.value` 保留原生转换 |
| `mo.ui.text` | 文本值、placeholder、max_length、disabled、debounce |
| `mo.ui.plotly` | Plotly 图形显示；点击、框选、套索和取消选择事件回传，读取 `.value` / `.points` / `.indices` |
| 普通 Plotly Figure | 原有显示与三维相机保留机制继续可用，无需包裹 `mo.ui.plotly` |

输入控件采用项目统一的蓝白样式，部分原生外观参数（如 full_width、include_input、searchable、slider orientation）不复刻。`mo.ui.plotly` 的事件载荷交给真实 marimo 对象转换；不同图表能否框选取决于 Plotly 本身，三维曲面不具备二维散点式框选。

**尚未接入**：`mo.ui.table`、form、array、dictionary、batch、tabs、button / run_button、AnyWidget、Altair 交互、`mo.state`、异步 cell、marimo 前端扩展、任意 JavaScript、`on_change` 回调。未支持的 UI 元素会给出明确的 cell 错误，避免只显示对象文字造成误解。通过标准 HTML 包裹的其他 marimo 自定义组件不在支持范围内。

这里的“图 → 下游”是选择事件，不等于已经支持“拖动曲面点 → 反向设置原滑杆”或任意 hover 回调。不要通过互相引用两个 cell 制造反馈循环。

普通二维 Plotly Figure 可选用水平拖动绑定一个数值控件：

```python
# 在独立 cell 创建并输出 expansion_point = mo.ui.slider(..., debounce=False)。
# 绘图 cell 读取 expansion_point.value，再设置：
fig.update_layout(meta={"noteControls": {"dragX": {"widget": "expansion_point"}}})
fig
```

在绘图区按住并左右拖动，会将横轴坐标写回指定 slider / number，并实时重算其下游；右侧控件的数值同步更新。快速拖动合并未处理的位置，松手提交最终位置。只支持线性 x 轴及普通数值控件，不支持 steps 列表；值按控件步长取整并限制在上下限内。省略配置时保持 Plotly 原有交互。该绑定适用于普通 Figure，不适用于 `mo.ui.plotly` 的选择事件。

## 从图像触发另一个 cell

Cell A：

```python
import marimo as mo
import plotly.graph_objects as go

chart = mo.ui.plotly(go.Figure(go.Scatter(
    x=[1, 2, 3], y=[2, 5, 4], mode="markers",
)))
chart
```

Cell B：

```python
selected = chart.value
mo.md(f"已选中 **{len(selected)}** 个点。")
```

点击散点或使用 Plotly 工具栏切到框选 / 套索，即可更新 Cell B。图形所在 cell 不会因选点而重建。清除选择后 `.value` 恢复为空列表。[官方 Plotly 说明](https://docs.marimo.io/api/plotting/)

## Agent / CLI 操作

`./notes run` / `runtime` 返回的 mo 输出结构为：

```json
{
  "kind": "marimo",
  "html": "...",
  "widgets": [
    {"key":"mo:运行期对象ID","cell":"moparams","name":"x1","type":"slider","value":0.8}
  ]
}
```

从 `state.outputs[CELL_ID].result.widgets` 读取真实 `key`，**不要猜测或长期保存它**。创建 cell 重跑后对象 ID 会变化；过期事件被拒绝，不会作用于新控件。

```bash
./notes --notebook src/slide_notes/examples/mo-linked.json run
./notes --notebook src/slide_notes/examples/mo-linked.json runtime

# KEY 替换为上一步 widgets 中返回的 key：
./notes --notebook src/slide_notes/examples/mo-linked.json run --control KEY 1.2

# 通用事件：第二个参数是 JSON。
./notes run --event KEY 'true'                 # checkbox
./notes run --event KEY '["立方"]'            # dropdown 的选项标签数组
./notes run --event KEY '"新文本"'             # text
./notes run --event KEY '{"points":[],"indices":[]}'  # 清除图表选择
```

最后四条需通过 `--notebook` 或 `SLIDE_NOTES_NOTEBOOK` 指向实际笔记，并使用对应类型控件的 KEY。`--control` 和 `--event` 互斥；事件不与 `--force` 或重跑创建者同时使用。图表点击事件示例：

```json
{"points":[{"x":2,"y":5,"curveNumber":0,"pointNumber":1,"pointIndex":1}],"indices":[1]}
```

默认 summary 省略普通 Plotly 和 mo Plotly 的大体积 figure，保留控件 key/value 和 HTML；需要完整 figure 使用 `--view outputs` 或 `--view all`。变量查看器显示控件类型及其 Python `.value`。其他原有 CLI 工作流程见 [Agent 指南](agent.md)。

## 实现和版本约束

- `src/slide_notes/notebook/marimo_bridge.py`：真实 UIElement 注册、事件验证与 `_update` 值转换、Html 输出。
- `src/slide_notes/notebook/runtime.py`：控件事件只使下游失效；记录富输出以同步同一控件的多个显示位置。
- `frontend/src/workbench/marimo-output.js`：DOMPurify 过滤、KaTeX、输入控件和 Plotly 事件。
- 内部属性访问集中在桥接层；依赖锁定 `marimo==0.25.1`，升级时需重新运行 `test_marimo.py` 和浏览器交互检查。
