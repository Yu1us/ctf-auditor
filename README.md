# ctf-auditor

面向 Pi 的 CTF 接管扩展。项目名、安装名和扩展目录名始终是 **ctf-auditor**；“handoff / 接管”只是 v2 的功能定位，不是改名。

## 开始任务

在 CTF 目标项目中安装扩展并启动 Pi：

```bash
cd "D:/Contest/your-ctf"
pi-link ctf-auditor
pi
```

然后直接向 Pi 描述题目并开始解题。v2 没有 `/ctf init`、`/ctf toggle` 或单独的“开启任务”命令；如果 Pi 已经启动，安装后执行 `/reload`。

需要人工接管时才使用：

```text
正常使用 Pi 原生工具解题
  → /ctf checkpoint
  → 阅读 machine.md、编辑 human.md
  → /ctf resume
  → 新 session 从人工确认的 resume.md 继续
```

扩展不会：

- 注册 agent 可调用的 `ctf_*` 工具；
- 修改 system prompt；
- 代理或限制原生 shell / 文件工具；
- 后台记录每次工具调用。

只有 `/ctf checkpoint` 和 `/ctf resume` 会调用当前模型。

## 安装

推荐在目标项目中使用同仓库的 `pi-link`：

```bash
pi-link ctf-auditor
```

它会将扩展链接到项目的 Pi 扩展位置：

```text
.pi/extensions/ctf-auditor/index.ts
```

当前实现适配 Pi `0.81.1`。扩展只使用 Node 和 Pi 自带 API，无运行时 npm 依赖。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/ctf checkpoint` | 从当前 session branch 和 workspace 生成接管包。 |
| `/ctf resume [checkpoint-id]` | 校验人工审阅，编译 `resume.md`，创建带父会话关系的新 session。 |
| `/ctf status` | 显示最新 checkpoint 和下一步。 |
| `/ctf complete` | 人工确认后标记当前 workspace 任务完成。 |
| `/ctf abort` | 中止最新待处理 checkpoint。 |

## Checkpoint

文件保存在：

```text
.pi/ctf-auditor/
├── state.json
└── CP-YYYYMMDD-NNN/
    ├── machine.md
    ├── human.md
    ├── resume.md
    ├── manifest.json
    └── raw/
```

`machine.md` 同时包含状态快照和停滞诊断。已有源码、日志和 exploit 只记录路径；只有被报告引用、且没有现成完整输出文件的 session 工具结果才会物化到 `raw/`。

## 人工审阅

`human.md` 至少需要：

```markdown
Decision: REDIRECT
Machine-Summary-Reviewed: YES

## 选择的方向

优先验证 H2。

## 下一项实验

执行最小判定实验。
```

可选 Decision：

- `CONTINUE`
- `REDIRECT`
- `PAUSE`
- `ABORT`

只有 `CONTINUE` 和 `REDIRECT` 可以 resume。未确认机器总结、未填写方向或下一项实验时，`/ctf resume` 会拒绝换会话。

## Resume

`/ctf resume` 会：

1. 重新读取并校验 `human.md`；
2. 以人工修改优先于机器总结的规则生成约 1,000～1,500 tokens 的 `resume.md`；
3. 调用 `ctx.newSession()` 创建带 `parentSession` 的新会话；
4. 把 `resume.md` 写成新会话初始 user message；
5. 自动发送 kickoff，让新 agent 先确认目标、假设和第一项实验再执行。

旧 session 保持不变，可用于查看完整历史。

## 开发检查

```bash
npm test
```

详细实现计划见 [`docs/MVP-plan.md`](docs/MVP-plan.md)。
