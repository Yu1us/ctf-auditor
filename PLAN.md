# ctf-auditor 最小实现计划

## 目标

为 Pi `0.80.x` 提供一个 CTF 审计 Extension，只约束最关键闭环：

```text
假设 → 有成功/失败判据的真实实验 → 原始输出 → 结论 → 下一步
```

默认仅用于合法 CTF、靶场和用户明确授权的环境。不读取或推断隐藏思维链。

## 必须保证

1. 初始化时记录授权范围和最小成功指标。
2. 同时最多 3 个活跃假设；每个假设必须可证伪。
3. strict 模式移除内置 `bash`，命令只能通过 `ctf_experiment` 执行。
4. 上一实验未归纳前禁止下一实验。
5. 完整 stdout/stderr、命令、cwd、退出码和时间落盘；模型只接收截断结果。
6. 合成测试不能产生 `OBSERVED` 结论；生成代码本身不算证据。
7. 同一假设连续两次 `REFUTES` 或无新增信息的 `INCONCLUSIVE` 后要求 replan。
8. 高风险命令必须人工批准；无 UI 时拒绝。所有执行限制在授权工作区。
9. 人工确认前不能把 run 标记为完成。

其余评分、Dashboard、远程后端、通用 Gate、reviewer LLM 和多模式策略暂不实现。

## 最小代码结构

```text
.pi/extensions/ctf-auditor/
├── index.ts       # 类型、状态、持久化、3 个工具、/ctf 命令和 Pi hooks
└── index.test.ts  # 一个可直接运行的状态机测试
```

不建 `models/`、`services/`、`repositories/`、backend 接口或 package；先使用 Node/Pi 已有 API。只有 `index.ts` 明显失控后再按职责拆文件。

运行数据：

```text
.pi/ctf-runs/<run-id>/
├── state.json
├── events.jsonl
└── experiments/E0001/
    ├── request.json
    ├── stdout.txt
    ├── stderr.txt
    └── result.json
```

`state.json` 用临时文件 + rename 原子更新；`events.jsonl` 只追加。无需为 hypothesis、claim、artifact 分别建立 ledger。

## 最小数据模型

```ts
type Grade = "OBSERVED" | "DERIVED" | "HYPOTHESIS" | "REJECTED";
type Verdict = "SUPPORTS" | "REFUTES" | "INCONCLUSIVE";

interface State {
  run: {
    id: string;
    authorizationScope: string;
    successCriterion: string;
    workspace: string;
    status: "ACTIVE" | "REPLAN_REQUIRED" | "COMPLETE" | "ABORTED";
  };
  hypotheses: Array<{
    id: string;
    statement: string;
    falsificationTest: string;
    successSignal: string;
    failureSignal: string;
    status: "ACTIVE" | "SUPPORTED" | "REFUTED" | "PARKED";
    consecutiveFailures: number;
  }>;
  experiments: Array<{
    id: string;
    hypothesisId: string;
    command: string;
    expectedSupports: string;
    expectedRefutes: string;
    sampleKind: "REAL" | "SYNTHETIC" | "POST_HOC";
    status: "RUNNING" | "AWAITING_CONCLUSION" | "CLOSED";
    result?: { exitCode: number; stdoutPath: string; stderrPath: string };
    conclusion?: {
      verdict: Verdict;
      observations: string[];
      claims: Array<{ statement: string; grade: Grade }>;
      nextAction: string;
    };
  }>;
  activeExperimentId?: string;
  seq: number;
}
```

实验目录和 experiment ID 本身就是证据引用，不再单独维护 `Evidence`、`Artifact`、`Gate`、`Resource` 实体。需要通用 Gate 或远程预算时再增加。

## Pi 接口

### `ctf_run`

动作：`init | add_hypothesis | park_hypothesis | replan | status`

- `init`：要求授权范围、成功指标和工作区。
- `add_hypothesis`：要求 statement、falsificationTest、successSignal、failureSignal。
- `replan`：记录理由，清除 `REPLAN_REQUIRED`。
- `status`：返回当前假设、待归纳实验和成功指标。

### `ctf_experiment`

参数：

```ts
{
  hypothesisId: string;
  command: string;
  expectedSupports: string;
  expectedRefutes: string;
  sampleKind: "REAL" | "SYNTHETIC" | "POST_HOC";
  risk: "LOW" | "HIGH";
  timeoutSeconds: number;
}
```

执行顺序：校验状态 → 必要时审批 → 在授权 cwd 执行 → 完整输出落盘 → 返回截断摘要 → 状态改为 `AWAITING_CONCLUSION`。

使用 Pi/Node 现有进程执行和截断能力，不自行实现 shell parser、进程树管理或日志框架。

### `ctf_conclude`

参数：

```ts
{
  experimentId: string;
  verdict: Verdict;
  observations: string[];
  claims: Array<{ statement: string; grade: Grade }>;
  nextAction: string;
}
```

规则：

- 只能归纳当前待处理实验；
- `SYNTHETIC` 的 claim 最高为 `HYPOTHESIS`；
- `POST_HOC` 不能产生原 run 的 `OBSERVED`；
- 关闭实验并更新假设；连续失败 2 次进入 `REPLAN_REQUIRED`。

### `/ctf`

只保留：

```text
/ctf status
/ctf complete
/ctf abort
```

`complete` 需要有 UI 的人工确认；无 UI 拒绝。状态展示使用一行 `setWidget()`，不写自定义 TUI 组件。

## 必要 Hooks

- `session_start`：加载 state，strict run 时移除内置 `bash` 并显示 Widget。
- `before_agent_start`：注入当前成功指标、活跃假设和阻塞原因。
- `tool_call`：阻止授权工作区外的 `write/edit`，并拒绝未知执行型工具。
- `session_shutdown`：flush 状态并恢复原 active tools。

不接入其余生命周期事件；工具执行记录已由 `ctf_experiment` 完成。

## 实现顺序

### 0. API spike

用最小临时代码验证：

- `setActiveTools()` 可移除/恢复 Bash；
- 自定义工具支持取消、timeout 和截断；
- 无 UI 审批可 fail-closed；
- Windows/Linux 下 cwd、路径 canonicalization 和进程终止有效。

验证结果直接写入本文件勾选，不单建 API 报告系统。

### 1. 单文件 MVP

1. 状态模型、原子保存和 JSONL 事件追加；
2. `ctf_run`；
3. strict Bash 切换；
4. `ctf_experiment` 与原始输出落盘；
5. `ctf_conclude` 与两次失败 replan；
6. `/ctf status|complete|abort` 和单行 Widget。

### 2. 仅补真实缺口

完成一次本地 CTF golden run 后，只修复实际暴露的问题。不要预先加入 balanced/observe、HTML 报告、Docker/SSH、评分器或可插拔 backend。

## 最小测试

`index.test.ts` 使用 Node `assert`，覆盖一条完整流程和关键拒绝：

1. 未初始化不能实验；
2. 第 4 个活跃假设被拒绝；
3. 未归纳时第二个实验被拒绝；
4. synthetic `OBSERVED` 被拒绝；
5. 连续两次失败进入 `REPLAN_REQUIRED`；
6. 工作区路径逃逸和无 UI 高风险命令被拒绝；
7. resume 后 state 可恢复。

另做一次人工集成检查：strict 下模型无法直接调用 Bash，实验原始输出可从磁盘回放。

## MVP 验收

- [ ] 授权范围和成功指标必填；
- [ ] strict 下无内置 Bash；
- [ ] 每个命令绑定假设及 supports/refutes 判据；
- [ ] 每次只允许一个待归纳实验；
- [ ] 原始输出和执行元数据可追溯；
- [ ] synthetic/post-hoc 不会提升为虚假观察；
- [ ] 两次失败强制 replan；
- [ ] 路径越界及无 UI 高风险操作 fail-closed；
- [ ] 人工确认后才能完成 run；
- [ ] resume 后状态不丢失。
