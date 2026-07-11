# ctf-auditor 最小实现计划

## 目标

为 Pi `0.80.x` 提供一个 CTF 审计 Extension，只约束最关键闭环：

```text
低风险探索（trace，可连续执行） ─┐
                               ├→ 关键假设 → 实验 → 结论 → 下一步
已有文件读取/搜索（安全工具） ────┘
```

审计粒度以“会改变解题方向的决策分叉”为单位，而不是以每条命令为单位。默认仅用于合法 CTF、靶场和用户明确授权的环境。

## 必须保证

1. 初始化时记录最小成功指标和工作区。
2. 同时最多 3 个活跃假设；每个假设必须可证伪。
3. 默认先做低成本验证，再扩大实验范围；低风险、短时、易回退且不直接构成关键结论的探索命令通过 `ctf_trace` 连续执行，关键验证通过 `ctf_experiment` 执行。
4. 正式实验仍保持“上一实验未归纳前禁止下一实验”；该约束不阻止安全的文件工具，也不要求把普通探索人为包装成实验。
5. 完整 stdout/stderr、命令和退出码落盘；模型只接收截断结果。
6. 合成测试不能产生 `OBSERVED` 结论；生成代码本身不算证据。
7. 同一假设连续两次 `REFUTES` 或 `INCONCLUSIVE` 后要求 replan。
8. “高风险”主要指证据不足时进行高耗时、高资源或过深探索；这类实验必须人工批准。不可逆操作同样需要批准，路径越界始终拒绝。
9. 人工确认前不能把 run 标记为完成。

其余评分、Dashboard、远程后端、通用 Gate、reviewer LLM 和多模式策略暂不实现。

## 自适应粒度

### 基本原则

审计对象是一次有意义的判断，而不是一次工具调用。定位文件、搜索符号、检查环境、纠正 shell 语法等操作通常只是探索步骤，不应各自创建假设并强制归纳。

使用两级执行模型：

- `trace`：低风险探索。自动保存命令、退出码、stdout/stderr，可在同一调查过程中连续执行，不要求逐条填写 supports/refutes 或调用 `ctf_conclude`。
- `experiment`：关键验证。必须绑定可证伪假设、预先声明支持/证伪判据，并在继续下一个正式实验前归纳。

以下任一条件成立时，应从 trace 升级为 experiment：

1. 结果会决定是否切换解题路线或淘汰一个主要假设；
2. 操作直接验证关键漏洞、利用链、flag 或最终成功标准；
3. 预计耗时、资源消耗、目标影响或回退成本明显增加；
4. 需要网络访问真实目标，或风险为 `HIGH` / `IRREVERSIBLE`；
5. 同类探索连续失败，继续尝试已不再是简单定位问题。

反之，读取、枚举、搜索、短时类型检查和局部静态检查默认可作为 trace。标准工具也可以直接使用；Auditor 不额外限制 `bash` 或 `write` / `edit` 路径。

同一路径上的逐步确认应保留在一个假设下；只有陈述的可证伪主张实质变化或出现新的决策分叉时才新增假设。系统提示应明确鼓励合并探索步骤，避免把“找到入口 → 查类型 → 编译 → 加载”机械拆成多个假设。

### 收归时机

trace 不逐条收归，但应在以下边界生成简短调查摘要，并把相关 trace ID 作为来源：

- 创建或修改正式假设前；
- 启动关键实验前；
- 改变路线、暂停假设或 replan 时；
- run 完成或中止时。

首期摘要可由模型写入下一次 hypothesis/experiment 的说明或 run 结束记录，不新增 claim/evidence 图谱。原始 trace 始终独立落盘，保证可回放。

## 最小代码结构

```text
.pi/extensions/ctf-auditor/
└── index.ts       # 类型、状态、持久化、3 个工具、/ctf 命令和 Pi hooks

.dev/
└── index.test.ts  # 仅开发阶段使用的状态机测试
```

不建 `models/`、`services/`、`repositories/`、backend 接口或 package；先使用 Node/Pi 已有 API。只有 `index.ts` 明显失控后再按职责拆文件。

运行数据：

```text
.pi/ctf-runs/<run-id>/
├── state.json
├── traces/T0001/
│   ├── request.json
│   ├── stdout.txt
│   ├── stderr.txt
│   └── result.json
└── experiments/E0001/
    ├── request.json
    ├── stdout.txt
    ├── stderr.txt
    └── result.json
```

`state.json` 用临时文件 + rename 原子更新，只保存状态机所需索引。实验请求、执行结果和结论以实验目录为准，无需额外事件日志，也不为 hypothesis、claim、artifact 分别建立 ledger。

## 最小数据模型

```ts
type Grade = "OBSERVED" | "DERIVED";
type Verdict = "SUPPORTS" | "REFUTES" | "INCONCLUSIVE";

interface TraceRequest {
  command: string;
  purpose: string;
  timeoutSeconds: number;
}

interface ExperimentRequest {
  hypothesisId: string;
  command: string;
  expectedSupports: string;
  expectedRefutes: string;
  sampleKind: "REAL" | "SYNTHETIC";
  risk: "LOW" | "HIGH" | "IRREVERSIBLE";
  timeoutSeconds: number;
}

interface State {
  run: {
    id: string;
    successCriterion: string;
    workspace: string;
    status: "ACTIVE" | "REPLAN_REQUIRED" | "COMPLETE" | "ABORTED";
  };
  traces: Array<{
    id: string;
    status: "RUNNING" | "CLOSED";
  }>;
  hypotheses: Array<{
    id: string;
    statement: string;
    falsificationTest: string;
    status: "ACTIVE" | "SUPPORTED" | "REFUTED" | "PARKED";
    consecutiveFailures: number;
  }>;
  experiments: Array<{
    id: string;
    hypothesisId: string;
    sampleKind: "REAL" | "SYNTHETIC";
    status: "RUNNING" | "AWAITING_CONCLUSION" | "CLOSED";
  }>;
  seq: number;
}
```

trace/实验目录及其 ID 本身就是来源引用，不再单独维护 `Evidence`、`Artifact`、`Gate`、`Resource` 实体。trace 与 experiment 使用独立序号，避免探索数量影响正式实验 ID。需要通用 Gate 或远程预算时再增加。

## Pi 接口

### `ctf_run`

动作：`init | add_hypothesis | park_hypothesis | replan | status`

- `init`：要求成功指标和工作区。
- `add_hypothesis`：要求 statement 和 falsificationTest。
- `replan`：清除 `REPLAN_REQUIRED`。
- `status`：返回当前假设、待归纳实验、最近结论、下一步和成功指标。

### `ctf_trace`

用于连续执行低风险探索命令，只要求 `command`、`purpose` 和 `timeoutSeconds`。每次调用分配 trace ID，并将请求、完整输出和退出码写入 `traces/T0001/`。它不改变假设状态、不累加连续失败次数，也不产生 `OBSERVED`/`DERIVED` 结论。

`ctf_trace` 只接受 `LOW` 风险；扩展检测到网络目标访问、明显高资源/长时操作或不可逆行为时应拒绝，并提示改用 `ctf_experiment`。trace 与实验使用相同的输出截断规则。

### `ctf_experiment`

参数：

```ts
{
  hypothesisId: string;
  command: string;
  expectedSupports: string;
  expectedRefutes: string;
  sampleKind: "REAL" | "SYNTHETIC";
  risk: "LOW" | "HIGH" | "IRREVERSIBLE";
  timeoutSeconds: number;
}
```

执行顺序：校验状态 → 判定是否审批 → 在授权工作区执行 → 完整输出落盘 → 返回截断摘要 → 状态改为 `AWAITING_CONCLUSION`。

风险规则：

- `LOW`：直接执行；读取、搜索、短时局部验证默认属于此类。
- `HIGH`：直接执行并记录。
- `IRREVERSIBLE`：始终需要批准；无 UI 时拒绝。
- `HIGH` 包含高耗时、高资源或过深探索；风险不按“命令看起来危险”判断，而按错误方向上的预期时间、CPU、网络、磁盘、影响范围和回退成本判断。

使用 Pi/Node 现有进程执行和截断能力，不自行实现 shell parser、进程树管理或日志框架。

### `ctf_conclude`

参数：

```ts
{
  experimentId: string;
  verdict: Verdict;
  grade: Grade;
  conclusion: string;
  nextAction: string;
}
```

规则：

- 只能归纳当前待处理实验；
- `SYNTHETIC` 的结论只能为 `DERIVED`；
- 将结论写入 `result.json`，关闭实验并更新假设；连续失败 2 次进入 `REPLAN_REQUIRED`。

### `/ctf`

```text
/ctf toggle
/ctf status
/ctf complete
/ctf abort
```

`complete` 需要有 UI 的人工确认；无 UI 拒绝。状态展示使用一行 `setWidget()`，不写自定义 TUI 组件。

### 审计开关

审计约束默认关闭。`/ctf toggle` 在开启和关闭之间切换：开启时增加 CTF 工具并注入工作流提示，标准工具始终可用；关闭时暂停提示注入。状态保存在项目的 `.pi/ctf-auditor.json`，因此 `/reload`、新建或切换 session 后会继承上次状态。

## 必要 Hooks

- `session_start`：加载 state 和项目开关配置；开启时在保留标准工具的同时增加 CTF 工具并显示 Widget。
- `before_agent_start`：仅审计模式注入当前成功指标、活跃假设、最近结论、下一步和阻塞原因。
- `session_shutdown`：flush 状态并恢复原 active tools。

不接入其余生命周期事件；工具执行记录已由 `ctf_experiment` 完成。

## 实现顺序

### 0. API spike

用最小临时代码验证：

- `setActiveTools()` 可移除/恢复 Bash；
- 自定义工具支持取消、timeout 和截断；
- 高成本/深探索且证据不足时触发审批，无 UI 可 fail-closed；
- Windows/Linux 下 cwd、路径 canonicalization 和进程终止有效。

验证结果直接写入本文件勾选，不单建 API 报告系统。

### 1. 单文件 MVP

1. 状态模型和原子保存；
2. `ctf_run`；
3. Bash 移除/恢复与 balanced 风险判定；
4. `ctf_experiment` 与原始输出落盘；
5. `ctf_conclude` 与两次失败 replan；
6. `/ctf status|complete|abort` 和单行 Widget。

### 2. 自适应粒度

1. 增加 `ctf_trace` 及 `traces/` 原始记录；
2. 在注入提示中明确 trace/experiment 的选择标准和升级边界；
3. 保留正式实验的单待归纳约束，trace 不创建待归纳状态；
4. 状态和回放中区分探索记录与正式实验，避免 trace 被展示成支持/证伪结论；
5. 用一次日常短任务和一次本地 CTF golden run 比较工具调用数、正式假设数及关键证据完整性。

### 3. 仅补真实缺口

完成上述回放后，只修复实际暴露的问题。不要预先加入 strict/observe 等额外模式、HTML 报告、Docker/SSH、评分器或可插拔 backend。

## 最小测试

`.dev/index.test.ts` 仅用于开发阶段，使用 Node `assert` 覆盖一条完整流程和关键拒绝：

1. 未初始化不能实验；
2. 第 4 个活跃假设被拒绝；
3. 未归纳时第二个正式实验被拒绝，但低风险 trace 不被误报为第二个实验；
4. trace 无法产生结论或更新假设状态，且高风险 trace 被要求升级为 experiment；
5. synthetic `OBSERVED` 被拒绝；
6. 连续两次正式实验失败进入 `REPLAN_REQUIRED`，trace 失败不计入；
7. 低成本局部 trace 无需审批且完整输出落盘；
8. 无证据的高成本/深探索、不可逆操作在无 UI 时被拒绝；
9. 即使获批，工作区路径逃逸仍被拒绝；
10. resume 后 state 和 trace 索引可恢复。

另做一次人工集成检查：模型无法绕过 `ctf_experiment` 直接调用 Bash，实验原始输出可从磁盘回放。

## MVP 验收

- [ ] 成功指标和工作区必填；
- [ ] 无内置 Bash，shell 命令经 trace/experiment 的 balanced 风险门；
- [ ] 普通探索无需伪造假设或逐条归纳，关键实验必须绑定假设及 supports/refutes 判据；
- [ ] 每次只允许一个待归纳的正式实验，trace 不占用该槽位；
- [ ] trace 与 experiment 的原始输出和执行元数据均可追溯；
- [ ] 日常短任务不会把文件定位、环境检查和 shell 纠错机械拆成多个正式实验；
- [ ] synthetic 不会提升为虚假观察；
- [ ] 两次失败强制 replan；
- [ ] 低成本 probe 不打断用户，无证据的高成本/深探索需要审批；
- [ ] 不可逆操作需审批，路径越界始终 fail-closed；
- [ ] 人工确认后才能完成 run；
- [ ] resume 后状态不丢失。
