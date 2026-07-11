# 单任务 CTF Run React Flow 可视化计划

## 决策与边界

首期将一个既有的 `run` 视为一个任务，不引入 `Task`、`nextTaskId` 或其他新的持久化字段。图仅展示指定 `<run-id>` 内已有的 Run、Hypothesis、Experiment 与 Conclusion；结论的 `nextAction` 作为 Conclusion 卡片和详情面板中的文本字段显示。

因此，**首期不需要修改数据模型**，也不修改 `state.json`、`request.json`、`result.json` 和审计状态机。

代价是首期不能将 `nextAction` 画成一条准确连接到“下一任务”的边：它目前只是自由文本，无法可靠推断其对应的假设或未来 run。多任务闭环留到后续在数据中加入显式引用后再做，不能靠文本匹配猜测关系。

## 目标

为 `/ctf flow <run-id>` 生成一个本地 HTML 回放页，使用户在一个画布上清晰查看单个 run 的：

```text
Run（本期唯一任务） → Hypothesis → Experiment → Conclusion
                                           └─ nextAction（文本）
```

页面基于 React Flow（`@xyflow/react`）实现，使用结构化卡片展示信息。它必须：

- 只读指定 run，生成过程不得改动审计数据或证据；
- 以卡片分栏显示字段，长文本不挤占图节点；
- 点击节点可在右侧检查器查看完整字段与证据文件链接；
- 用颜色、形状和带文字的边区分状态及关系；
- 可缩放、平移、`fitView`，并提供 Minimap 和 Controls；
- 离线工作：生成页只引用随 Extension 发布的本地构建资源，不依赖 CDN、服务器或网络。

## 非目标

本期不实现：

- 多 run / 多任务时间线，或 `Conclusion → 新任务` 的可点击边；
- 编辑节点、拖拽后保存位置、图上修改审计数据；
- stdout/stderr 正文嵌入或全文搜索；
- 筛选、图节点折叠、导出 PNG/SVG、实时刷新、Web Server 或 Pi 自定义 TUI；

## 数据与只读视图

复用 `run-visualization.ts` 的 `loadRunView()`，继续以 `state.json` 的顺序作为稳定顺序。新增纯函数将 `RunView` 裁剪为浏览器需要的可 JSON 序列化 DTO，而不是复制一份字段完全相同的视图：

```ts
type FlowVariant = "active" | "supported" | "refuted" | "pending" | "parked" | "closed" | "error";

interface FlowDocument {
  run: FlowRun;
  hypotheses: FlowHypothesis[];
  orphanExperiments: FlowExperiment[];
  warnings: string[];
}

function buildFlowDocument(view: RunView): FlowDocument;
function renderRunFlowHtml(document: FlowDocument, assetUrls: ViewerAssets): string;
async function generateRunFlow(
  runsRoot: string,
  runId: string,
  viewerAssetsDir: string,
): Promise<FlowGenerationResult>;
```

`FlowRun`、`FlowHypothesis`、`FlowExperiment` 和 `FlowConclusion` 只包含节点卡片及检查器实际展示的字段。`buildFlowDocument()` 同时负责：

- 使用共享的状态分类逻辑，将结果映射为 `FlowVariant`；React 端不得再维护第二套状态语义；
- 从 request/result 中显式挑选 command、supports/refutes、timeout、执行信息和 conclusion，不能把解析后的原始对象整体内联；
- 为四个证据文件生成相对于 `run.html` 的 URL 编码链接及 `PRESENT/MISSING/INVALID` 状态；
- 保留 hypothesis、experiment 和 conclusion 的稳定索引，供前端生成无冲突节点 ID。

其他约束：

- 不读取或内联 stdout/stderr 正文；检查器只显示状态和本地链接。
- `request.json`、`result.json` 提供原文件链接；页面只内联上述选定字段，不复制未知字段或完整原始对象。
- 嵌入 HTML 的 JSON 必须转义 `<`、`>`、`&`、U+2028 和 U+2029，避免 run 中的用户文本结束 `<script>` 或破坏页面。
- 沿用现有 run-id 校验、缺失附件降级和 warning 汇总逻辑，不为 Flow 重写加载器。
- 生成 `run.html` 时使用临时文件加 `rename` 原子替换；仅写入该派生文件。

## 页面和图设计

### 固定结构

页面由三个区域组成：

```text
┌──────────────────── 顶栏：Run ID / 状态 / success criterion ───────────────────┐
├────────────── 图画布（React Flow） ──────────────┬───── 详情检查器 ─────────────┤
│ [Run] → [Hypothesis] → [Experiment] → [Conclusion] │ 选中节点的完整字段、文件链接 │
│                  ...                              │                                │
└───────────────────────────────────────────────────┴────────────────────────────────┘
```

- Run 卡片是本期的“任务”根节点，显示 ID、状态、success criterion、workspace 摘要。
- 每个 Hypothesis 是一条独立泳道；其 Experiment 与 Conclusion 按 `state.json` 的顺序排列。
- orphan experiment 置于 `Orphan / invalid relation` 区域，由 Run 直接连入并使用错误样式。
- `nextAction` 显示在 Conclusion 卡片的最后一栏，字段名明确为“下一步（文本）”，不伪装为已建立的任务节点。
- 节点卡片只显示摘要并做行数截断；点击后检查器显示完整值。这样 command、supports/refutes 判据、conclusion 等字段不会混为一段标签。

### 节点字段

| 节点 | 画布卡片 | 检查器 |
| --- | --- | --- |
| Run | ID、状态、成功标准摘要 | 成功标准、workspace、warnings |
| Hypothesis | ID、状态、statement 摘要、失败次数 | statement、falsificationTest、关联实验 |
| Experiment | ID、状态、sample kind、risk、command 摘要、exit code | command、expectedSupports、expectedRefutes、timeout、执行信息、四个证据文件链接 |
| Conclusion | verdict、grade、conclusion 摘要、nextAction 摘要 | 完整 conclusion、nextAction、来源 experiment |

### 状态和边

- 状态颜色沿用当前语义：蓝色 active、绿色 supported/supports/complete、红色 refuted/refutes/aborted、黄色 pending/inconclusive/replan、灰色 parked/closed、红色虚线 error。
- 卡片头部使用状态色条；不能只依赖颜色，状态文字必须始终可见。
- 边显示固定语义：`contains`（Run → Hypothesis）、`tests`（Hypothesis → Experiment）、`concludes`（Experiment → Conclusion）。orphan 边标为 `missing hypothesis`。
- 初始节点位置由纯布局函数稳定计算：Run 在左，假设泳道从上到下，实验与结论向右展开。卡片高度受控，避免根据长文本产生重叠；页面加载后调用 `fitView`。

## 前端构建与文件布局

当前 Extension 没有前端构建链。仅为该查看器新增最小 React/Vite 构建，不接入后端：

```text
.pi/extensions/ctf-auditor/
├── index.ts
├── run-visualization.ts        # 加入 FlowDocument/HTML 生成，不混入 React 代码
└── viewer/
    ├── src/
    │   ├── main.tsx            # 读取 window.__CTF_RUN_FLOW__，挂载 React Flow
    │   ├── graph.ts            # 纯布局及 node/edge 转换，不重复状态映射
    │   ├── nodes.tsx           # 四类节点共用卡片外壳
    │   ├── inspector.tsx       # 只读详情面板
    │   └── styles.css
    ├── vite.config.ts
    └── dist/                   # 随 Extension 发布的本地 JS/CSS 构建产物

package.json                    # @xyflow/react、react、react-dom；Vite/TypeScript 开发依赖
package-lock.json
```

- Vite 输出单个 IIFE JavaScript 与 CSS；HTML 用普通 `<script>` 引用，而不依赖 `file://` 下可能受限的 ES module 解析。
- `generateRunFlow()` 接收构建资源目录，通过 `relative(runDir, viewerAssetsDir)` 计算资源 URL；不得假设 runs 根目录固定在项目工作目录。
- 页面将 `FlowDocument` 以内联 `window.__CTF_RUN_FLOW__` 传给 bundle，避免在 `file://` 页面中用 `fetch()` 读取 JSON。
- `index.ts` 从 Extension 自身目录定位 `viewer/dist`，调用生成器；构建产物缺失时给出明确的构建提示，不生成半成品页面。
- 前端纯函数测试沿用现有 Node `assert` 风格；除非现有方式无法运行，否则不再引入 Vitest 等测试框架。

## 命令接口

提供以下命令：

```text
/ctf flow <run-id>
```

行为：

1. 复用 run-id 自动补全；
2. 校验并读取指定 run；
3. 生成 `.pi/ctf-runs/<run-id>/run.html`；
4. 在 Pi 中只通知输出路径、图节点数和 warnings；不自动启动浏览器或 Web Server；
5. 将 `flow` 加入命令帮助、README 和补全列表。

## 实施顺序

### 1. 构建验证

- 添加 React、React DOM、`@xyflow/react` 和 Vite；
- 直接建立正式查看器入口，用一个临时的最小 `FlowDocument` 验证构建，不创建独立的无数据页面或第二套 HTML 模板；
- 以 `file://` 打开生成的最小 HTML，确认本地 JS、CSS、缩放、Minimap 均可用，随后删除临时数据。

### 2. 生成器

- 在 `run-visualization.ts` 中复用现有状态分类逻辑，从 `RunView` 构建经过字段裁剪的 `FlowDocument`；
- 实现安全 JSON 内联、相对资源 URL、原子写入 `run.html`；
- 复用既有损坏附件、orphan 和 run-id 错误处理。

### 3. 查看器

- 实现稳定的泳道布局以及四类节点卡片；
- 使用 DTO 已给出的 `FlowVariant` 实现状态样式，并生成语义边、Controls、MiniMap、`fitView`；
- 实现点击选择和只读检查器，提供证据文件链接；
- 窄屏仅用 CSS 将检查器移到画布下方，不增加折叠状态和交互。

### 4. Extension 接入

- 注册 `/ctf flow <run-id>`、帮助文本和补全；
- 从 Extension 目录传入 viewer 构建资源位置；
- 更新 README。

### 5. 人工回放

使用以下 run 检查生成页：

- 多假设且存在多个已关闭实验；
- 有 `AWAITING_CONCLUSION` 实验的活跃 run；
- 有缺失或损坏附件的 run；
- 有 orphan experiment 的 run；
- 含中文、引号、反斜杠、HTML 相关字符和超长 command/conclusion 的 run。

## 测试计划

### Node 生成器测试

扩展 `.dev/run-visualization.test.ts`，只补充 Flow 特有行为；非法 run-id、附件损坏、orphan、warning 汇总和只读加载等已有用例继续覆盖共享的 `loadRunView()`，不复制一套测试：

1. `buildFlowDocument()` 只保留允许展示的字段，并将各类状态映射为预期 `FlowVariant`；
2. 相同输入生成完全一致的 `FlowDocument` 与 HTML；
3. HTML 安全内联完整 DTO 和 `nextAction`，用户文本无法注入或结束数据 `<script>`；
4. 四个证据链接及构建资源 URL 在不同 runsRoot 与 viewerAssetsDir 下均正确；
5. 共享加载器产生的附件状态、orphan 和 warnings 被原样转换到 DTO；
6. `run.html` 生成后 `state.json` 和所有证据原文完全不变。

### 前端单元测试

只覆盖纯 `graph.ts` 的布局及节点/边转换，不重复测试生成器中的状态映射：

1. 节点 ID 与边稳定且无冲突；
2. 同一 hypothesis 下多个 experiment 不重叠；
3. `contains`、`tests`、`concludes` 和 orphan 错误边正确；
4. 节点直接使用 DTO 提供的 variant；
5. `nextAction` 只作为结论字段出现，不生成虚假的新任务边。

### 人工验收

- [ ] `run.html` 双击或以 `file://` 打开后无需网络即可显示；
- [ ] 可看清每张卡片的字段名称和值；
- [ ] 点击任意节点可检查完整字段与可用证据文件；
- [ ] 画布可缩放、平移、定位全图；
- [ ] `nextAction` 明确可见，且未被误表示成已有的后续任务；
- [ ] 缺失/损坏数据可见且不阻止其余图展示；
- [ ] 可视化生成不改变审计状态或证据。

## 后续：多任务闭环

只有单任务页面验证有效后，再考虑新增显式任务与来源引用，例如 `Task.id`、`Task.createdFromConclusionId` 和 `Conclusion.nextTaskId`。届时才可正确渲染：

```text
Conclusion C0001 ──creates──> Task T0002 ──contains──> Hypothesis H000x
```

在没有这些引用前，禁止通过 `nextAction` 的自然语言内容匹配已有对象来补边。
