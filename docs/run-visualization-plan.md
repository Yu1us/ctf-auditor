# CTF Run 可视化实现计划

## 目标

为 `.pi/ctf-runs/<run-id>/` 中的指定 run 生成可回放的流程视图。第一阶段只生成 Mermaid 文本，不引入浏览器、HTML、Web Server 或自定义 TUI。

首期闭环：

```text
run-id → 读取并校验运行数据 → 构建只读视图模型 → 生成 Mermaid flowchart → 输出/落盘 .mmd
```

可视化功能必须只读，不能改变 `state.json`、实验状态或原始证据。

## 当前数据源

```text
.pi/ctf-runs/<run-id>/
├── state.json
└── experiments/<experiment-id>/
    ├── request.json
    ├── stdout.txt
    ├── stderr.txt
    └── result.json
```

- `state.json`：run、hypothesis、experiment 索引及状态；
- `request.json`：命令、supports/refutes 判据、样本类型、风险和 timeout；
- `result.json`：执行状态及 conclusion；
- `stdout.txt`、`stderr.txt`：首期不嵌入图中，只显示是否存在，并保留对应文件路径。

读取时以 `state.json` 的顺序为主。实验详情文件缺失或 JSON 损坏时仍应尽可能生成图，并在节点上标记 `MISSING` 或 `INVALID`，不能让整个 run 无法展示。

## 第一阶段范围：Mermaid 生成

### 图结构

使用 Mermaid `flowchart LR`，按下面的关系构图：

```text
Run
 ├─ Hypothesis H0001
 │   ├─ Experiment E0001
 │   │   └─ Conclusion
 │   └─ Experiment E0002
 └─ Hypothesis H0002
     └─ Experiment E0003
```

节点内容控制在摘要级别：

- Run：ID、状态、成功指标、workspace；
- Hypothesis：ID、状态、statement、连续失败次数；
- Experiment：ID、状态、sample kind、risk、command、exit code；
- Conclusion：verdict、grade、conclusion、next action；
- 异常节点：缺失文件、无对应 hypothesis、无法解析的 JSON。

边语义：

- `Run --> Hypothesis`：run 包含假设；
- `Hypothesis --> Experiment`：实验验证该假设；
- `Experiment --> Conclusion`：实验已经归纳；
- 找不到 hypothesis 的实验直接由 Run 连接，并使用异常样式。

### 状态样式

用稳定的 `classDef` 区分状态，不依赖主题中的默认颜色：

- `active`：蓝色；
- `supported` / `supports` / `complete`：绿色；
- `refuted` / `refutes` / `aborted`：红色；
- `pending` / `inconclusive` / `replan`：黄色；
- `parked` / `closed`：灰色；
- `error`：红色虚线边框。

节点 ID 只使用内部生成的安全标识，例如 `run_0`、`hyp_0`、`exp_0`、`conclusion_0`，不直接把 run-id 或用户文本当作 Mermaid 标识符。

### 文本安全和可读性

生成器必须统一处理 Mermaid 标签：

1. 转义 `"`、反斜杠、换行及 Mermaid/HTML 敏感字符；
2. 用户文本转为单行摘要，默认最多 120 个字符；
3. 命令默认最多 160 个字符；
4. 不嵌入 stdout/stderr，避免图过大以及原始输出破坏语法；
5. 输出顺序必须稳定，确保相同 run 多次生成结果一致；
6. 不在图中加入生成时间，避免无意义 diff。

## 建议接口

先把读取、建模和渲染分开，避免 Mermaid 语法与磁盘格式耦合：

```ts
interface RunView {
  run: RunSummary;
  hypotheses: HypothesisView[];
  orphanExperiments: ExperimentView[];
  warnings: string[];
}

async function loadRunView(runsRoot: string, runId: string): Promise<RunView>;
function renderRunMermaid(view: RunView): string;
async function generateRunMermaid(runsRoot: string, runId: string): Promise<string>;
```

首期对外入口建议扩展 `/ctf` 命令：

```text
/ctf mermaid <run-id>
```

行为：

1. `run-id` 必填，且只能是 `.pi/ctf-runs` 下的直接子目录名；
2. 生成 `.pi/ctf-runs/<run-id>/run.mmd`；
3. UI 中只报告输出路径、节点数量和 warnings，不回显可能很长的完整图；
4. 若目标 run 不存在或 `state.json` 无法解析，则失败且不创建半成品；
5. 使用临时文件加 rename 原子写入 `run.mmd`。

为便于测试和后续接入其他展示方式，`renderRunMermaid()` 必须是无文件 IO 的纯函数。后续如需要命令行入口，可以复用 `generateRunMermaid()`，不复制解析逻辑。

## 代码组织

当前 `index.ts` 已承担状态机、工具和 hooks，新增逻辑不继续堆入该文件：

```text
.pi/extensions/ctf-auditor/
├── index.ts             # 注册 /ctf mermaid 并调用生成器
└── run-visualization.ts # 数据读取、RunView 和 Mermaid 渲染

.dev/
├── index.test.ts             # 状态机测试
└── run-visualization.test.ts # Mermaid 生成器测试
```

生成器只依赖 Node 标准库，不增加 Mermaid npm 运行时依赖；Mermaid 在这一阶段只是输出格式。

## 实现顺序

### 1. 固化输入模型

- 从现有 `State`、`ExperimentRequest` 和 result 文件提取可视化所需类型；
- 明确可选字段和损坏数据的降级规则；
- 增加安全的 run-id/path 校验，拒绝绝对路径和 `..` 路径逃逸。

### 2. 实现只读加载器

- 读取指定 run 的 `state.json`；
- 按 experiment ID 加载 `request.json` 与 `result.json`；
- 检测 stdout/stderr 是否存在，但不读取文件内容；
- 汇总 warning，不因单个实验附件缺失而终止。

### 3. 实现 Mermaid 纯渲染器

- 生成稳定节点 ID；
- 生成 Run、Hypothesis、Experiment、Conclusion 节点和边；
- 统一截断、转义和状态 class 映射；
- 最后集中输出 `classDef`，保证结果可直接交给 Mermaid 渲染。

### 4. 接入 `/ctf mermaid <run-id>`

- 更新命令说明与参数补全；
- run-id 补全可列出 `.pi/ctf-runs` 的直接子目录；
- 原子写入 `run.mmd`；
- 保持现有 `status|complete|abort|dev|audit` 行为不变。

### 5. 用真实 run 验证

至少使用以下三类现有数据验证：

- 已终止且包含多个实验的 run；
- 活跃 run；
- 仅有 `state.json` 或附件不完整的 run。

把生成的 `.mmd` 粘贴到 Mermaid Live Editor 或支持 Mermaid 的 Markdown 查看器中进行一次人工渲染检查。

## 测试计划

单元测试至少覆盖：

1. 一个 hypothesis 对应多个 experiment，关系正确；
2. `SUPPORTS`、`REFUTES`、`INCONCLUSIVE` 映射到正确样式；
3. 尚无 `result.json` 的实验显示为 pending；
4. request/result 缺失或损坏时生成 warning 和异常节点；
5. experiment 引用不存在的 hypothesis 时成为 orphan；
6. 中文、引号、反斜杠、换行、Mermaid 敏感字符不会破坏语法；
7. 超长 statement、command、conclusion 被稳定截断；
8. 相同输入重复生成完全相同的 Mermaid；
9. 拒绝 `../`、绝对路径及不存在的 run；
10. 命令写入 `run.mmd`，且不修改任何原始 run 文件。

## 第一阶段验收

- [ ] 可通过明确的 run-id 生成 `run.mmd`；
- [ ] 图中能看出 Run → Hypothesis → Experiment → Conclusion；
- [ ] 状态和 verdict 有清晰、一致的颜色；
- [ ] 中文和命令文本不会造成 Mermaid 语法错误；
- [ ] 不读取或嵌入 stdout/stderr 正文；
- [ ] 局部附件损坏时仍可生成带 warning 的图；
- [ ] 路径逃逸被拒绝；
- [ ] 生成过程不修改审计状态和证据；
- [ ] 对现有真实 run 完成至少一次人工渲染验证。

## 后续阶段（本次不实现）

1. 在 Pi TUI 中预览或打开生成结果；
2. 生成自包含 HTML/SVG；
3. 点击实验节点查看 request、result、stdout/stderr；
4. 大型 run 的折叠、筛选和按 hypothesis 分图；
5. 多个 run 的对比视图。

只有 Mermaid MVP 在真实 run 上验证后，再选择具体展示载体，避免过早绑定 Web 或 TUI 技术方案。
