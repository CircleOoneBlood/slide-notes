# 前端依赖审计记录

审计日期：**2026-10-17**。范围为 `frontend/package-lock.json`、独立 `npm ci` 后的 `npm audit --json`、源码入口与随源码交付的浏览器 bundle。本轮没有修改依赖版本或锁文件。

审计报告列出 **13 个受影响包：2 high、8 moderate、3 low**。其中包含依赖链传播的告警，不能理解为 13 个独立漏洞。报告关联 5 个根包、27 条不同 advisory。

## 版本、运行范围和候选修补

| 包与现有版本 | 核实结果 | 候选修补 |
| --- | --- | --- |
| `@xmldom/xmldom` **0.9.10** | High；由 MathJax 的 `speech-rule-engine` **4.1.4** 引入。当前应用的数学渲染入口没有将这两个包打入浏览器 bundle。 | **0.9.12** 修补该报告中的问题；上游精确锁定 0.9.10，需要评估 override 或兼容的上游更新。[advisory](https://github.com/advisories/GHSA-965w-775f-mr7g) |
| 嵌套 `lodash-es` **4.17.21**，共 3 份 | High；来自 Chevrotain **11.0.3** 及其子包。Mermaid bundle 包含部分 lodash 工具，报告涉及的 `template`、`unset`、`omit`、`_baseUnset` 没有进入交付 bundle。 | **4.18.0** 修补报告中的代码注入及原型污染问题；嵌套依赖使用精确版本，需要评估 override，并验证图表。[代码注入](https://github.com/advisories/GHSA-r5fr-rjxr-66jc)、[原型污染](https://github.com/advisories/GHSA-f23m-r3pf-42rh) |
| `mdast-util-to-hast` **13.2.0** | Moderate；进入 Markdown bundle。应用自定义的代码块 handler 也存在同类 class 注入，已在本轮修复。依赖版本本身仍会被 audit 标记。 | 可评估 **13.2.1** 补丁更新，保留本地 handler 修复及回归。[advisory](https://github.com/advisories/GHSA-4fh9-h7wg-q85m) |
| `mermaid` **11.12.0** | 浏览器运行时使用；现有版本位于报告中图表 CSS/HTML、配置、原型污染及拒绝服务 advisory 的受影响范围。 | **11.16.1** 修补报告列出的 Mermaid 自身问题；audit 建议同主版本 **11.17.2**，同时处理 parser 依赖链。需要独立图表回归，本轮未升级。[CSS advisory](https://github.com/advisories/GHSA-6x64-9x62-f2gx)、[XY 图表 advisory](https://github.com/advisories/GHSA-2v8p-3f2j-5mp7) |
| 嵌套 `katex` **0.16.47**；顶层 **0.19.0** | Low；Mermaid 的嵌套副本进入图表 bundle。Markdown 使用 MathJax，`micromark-extension-math` 的 KaTeX HTML helper 没有进入 Markdown bundle。顶层 0.19.0 不在该 advisory 范围。 | 嵌套副本需 **≥0.18.2**；超出当前 `^0.16` 范围，应验证兼容性。该 advisory 需要已有原型污染或可控选项原型等前提。[advisory](https://github.com/advisories/GHSA-238p-pmpm-9mq7) |

## 证据范围和剩余事项

通过 esbuild metafile 检查 `markdown-math-src.js`、`markdown-renderer-src.js` 和 `markdown-diagrams-src.js` 的输出输入图；审计时临时重建的三个 bundle 与当时交付资源逐字节一致。上表关于未打入 bundle 的结论仅适用于这些应用入口与构建结果；相关包仍存在于开发依赖安装树中。可以使用 esbuild 的 `--metafile` 选项复核。

自定义代码块 handler 的缺陷已用真实浏览器和无害标记复现：语言标记 `js&#x20;audit-marker` 曾产生额外 `audit-marker` class。修复后只保留解码后的首个语言 token。`test_obsidian_markdown.cjs` 覆盖编码空格、制表符、换行，并验证正常 JavaScript/Python 高亮及原始笔记源码保持不变。

Mermaid 当前使用 strict 模式、禁止点击绑定，并在插入前执行 SVG DOMPurify 清洗。其 SVG 独占包装元素也符合上述 CSS advisory 的部分缓解建议。这些措施没有证明所有 advisory 路径均不可达，尤其不能据此消除渲染阶段的拒绝服务告警；本轮没有执行恶意拒绝服务样例。

后续依赖更新应重新运行 audit、重建资源并完成 Markdown/公式/图表浏览器回归。不要直接采用 `npm audit fix --force` 给出的 `remark-math` **6.0.0 → 3.0.1** 降级建议；它会改变现有解析器依赖组合。
