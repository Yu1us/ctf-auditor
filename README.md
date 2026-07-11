# ctf-auditor

面向 Pi 的 CTF 审计扩展：将解题过程约束为可追溯的闭环。

```text
假设 → 带有支持/证伪判据的实验 → 原始输出 → 结论 → 下一步
```

> 仅用于合法 CTF、靶场和明确获授权的目标环境。

## 功能

- 初始化时记录成功标准和授权工作区。
- 最多同时维护 3 个可证伪假设。
- 命令统一经 `ctf_experiment` 执行；每次实验必须绑定假设及 supports/refutes 判据。
- 上一个实验归纳完成前，不能开始下一个实验。
- 完整保存命令、退出码、stdout 和 stderr；返回给模型的输出会截断。
- 合成样本不能得出 `OBSERVED`（观察到的）结论。
- 同一假设连续两次得到 `REFUTES` 或 `INCONCLUSIVE` 后，必须重新规划。
- 阻止授权工作区之外的写入和编辑，并拦截未知的执行型工具。

## 安装

将扩展放在 Pi 配置目录的扩展位置：

```text
.pi/extensions/ctf-auditor/
├── index.ts
└── run-visualization.ts
```

启动 Pi 后，扩展会注册 `ctf_run`、`ctf_experiment`、`ctf_conclude` 三个工具，以及 `/ctf` 命令。

## 使用流程

1. 通过 `ctf_run` 的 `init` 动作提供成功标准和已授权的工作区。
2. 用 `add_hypothesis` 添加可证伪假设，说明其证伪方法。
3. 用 `ctf_experiment` 执行一个低风险验证，并明确什么结果支持或证伪假设。
4. 立刻用 `ctf_conclude` 记录结论和下一步。
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
| `/ctf status` | 显示当前审计状态。 |
| `/ctf complete` | 经人工确认后完成运行。 |
| `/ctf abort` | 中止当前运行。 |
| `/ctf mermaid <run-id>` | 为指定运行生成 Mermaid 流程图。 |

## 风险控制

- `LOW`：低成本的读取、搜索和局部验证，可直接运行。
- `HIGH`：若该假设尚无已关闭的真实实验，需要人工批准；没有可用 UI 时会拒绝执行。
- `IRREVERSIBLE`：始终需要人工批准。
- 授权工作区外的路径始终被拒绝，批准不能绕过此限制。

审计模式下，内置 `bash` 不可直接使用，所有命令必须经 `ctf_experiment` 执行。

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

`state.json` 保存运行状态；每个实验目录保存请求、原始输出、执行结果和结论。使用 `/ctf mermaid <run-id>` 会在对应运行目录中生成只读流程图文件 `run.mmd`，用于回放假设、实验与结论之间的关系。
