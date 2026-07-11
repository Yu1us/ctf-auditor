# ctf-auditor

面向 Pi 的 CTF 审计扩展：将解题过程约束为可追溯的闭环。

```text
假设 → 带有支持/证伪判据的实验 → 原始输出 → 结论 → 下一步
```

> 仅用于合法 CTF、靶场和明确获授权的目标环境。

## 功能

- 初始化时记录成功标准和授权工作区。
- 最多同时维护 3 个可证伪假设。
- 低风险探索命令经 `ctf_trace` 连续执行并自动留存；关键验证才使用 `ctf_experiment` 绑定假设及 supports/refutes 判据。
- 上一个正式实验归纳完成前，不能开始下一个正式实验；普通 trace 不需要逐条归纳。
- 完整保存命令、退出码、stdout 和 stderr；返回给模型的输出会截断。
- 合成样本不能得出 `OBSERVED`（观察到的）结论。
- 同一假设连续两次得到 `REFUTES` 或 `INCONCLUSIVE` 后，必须重新规划。
- 阻止授权工作区之外的写入和编辑，并拦截未知的执行型工具。

## 安装

将扩展放在 Pi 配置目录的扩展位置：

```text
.pi/extensions/ctf-auditor/
├── index.ts
├── run-visualization.ts
└── viewer/dist/          # React Flow 本地构建资源
```

若从源码安装，先在项目根目录运行 `npm install` 和 `npm run build:viewer`。启动 Pi 后，扩展会注册 `ctf_run`、`ctf_experiment`、`ctf_conclude` 三个工具，以及 `/ctf` 命令。

## 使用流程

1. 通过 `ctf_run` 的 `init` 动作提供成功标准和已授权的工作区。
2. 用 `add_hypothesis` 添加可证伪假设，说明其证伪方法。
3. 用 `ctf_trace` 完成文件定位、搜索和短时静态检查；当结果会改变路线或验证关键漏洞时，改用 `ctf_experiment` 并明确支持/证伪判据。
4. 正式实验后立刻用 `ctf_conclude` 记录结论和下一步。
5. 达到成功标准后，以 `/ctf complete` 完成运行；该操作需要人工确认。

### 工具

#### `ctf_run`

用于管理审计运行和假设：

| 动作 | 说明 |
| --- | --- |
| `init` | 创建运行；需要 `successCriterion` 和 `workspace`。 |
| `add_hypothesis` | 添加假设；需要 `statement` 和 `falsificationTest`。 |
| `park_hypothesis` | 暂停一个活跃假设。 |
| `replan` | 在要求重新规划后恢复运行。 |
| `status` | 查看运行、假设、待归纳实验和下一步。 |

#### `ctf_trace`

用于工作区内低风险、短时、易回退的探索命令：

```ts
{
  command: "...",
  purpose: "本次探索的目的",
  timeoutSeconds: 30
}
```

trace 会完整保存命令和输出，但不更新假设状态，也不需要调用 `ctf_conclude`。网络目标访问、高成本、不可逆或会决定解题路线的验证必须使用 `ctf_experiment`。

#### `ctf_experiment`

执行单个实验：

```ts
{
  hypothesisId: "H0001",
  command: "...",
  expectedSupports: "什么结果会支持该假设",
  expectedRefutes: "什么结果会证伪该假设",
  sampleKind: "REAL", // 或 "SYNTHETIC"
  risk: "LOW",        // 或 "HIGH"、"IRREVERSIBLE"
  timeoutSeconds: 30
}
```

实验完成后会处于待归纳状态，必须先调用 `ctf_conclude`。

#### `ctf_conclude`

记录待归纳实验的结论：

```ts
{
  experimentId: "E0001",
  verdict: "SUPPORTS", // 或 "REFUTES"、"INCONCLUSIVE"
  grade: "OBSERVED",   // 或 "DERIVED"
  conclusion: "基于输出得出的结论",
  nextAction: "下一步行动"
}
```

`SYNTHETIC` 样本只能使用 `DERIVED` 结论等级。

### `/ctf` 命令

| 命令 | 说明 |
| --- | --- |
| `/ctf toggle` | 开启或关闭审计约束；默认关闭，状态跨 session 保存。 |
| `/ctf status` | 显示当前审计状态。 |
| `/ctf complete` | 经人工确认后完成运行。 |
| `/ctf abort` | 中止当前运行。 |
| `/ctf flow <run-id>` | 为指定运行生成可离线打开的 React Flow 回放页。 |

## 风险控制

- `LOW`：低成本的读取、搜索和局部验证，可直接运行。
- `HIGH`：可直接运行并记录。
- `IRREVERSIBLE`：始终需要人工批准；没有可用 UI 时会拒绝执行。

扩展默认关闭审计约束。使用 `/ctf toggle` 开启后，标准工具仍可直接使用；需要保留低风险命令输出时可使用 `ctf_trace`，关键验证使用 `ctf_experiment`。Auditor 不额外限制 `bash` 或 `write` / `edit` 路径。开关状态保存在项目的 `.pi/ctf-auditor.json`，新建或切换 session 时会继承上次状态。

## 运行记录与可视化

每次运行的数据保存在：

```text
.pi/ctf-runs/<run-id>/
├── state.json
└── experiments/<experiment-id>/
    ├── request.json
    ├── stdout.txt
    ├── stderr.txt
    └── result.json
```

`state.json` 保存运行状态；每个实验目录保存请求、原始输出、执行结果和结论。使用 `/ctf flow <run-id>` 会生成 `run.html`，双击即可离线查看可缩放、可平移并带详情检查器的回放页；该操作不会修改审计状态或证据。
