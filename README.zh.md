# 交接中枢（Handoff Hub）

**让同一工作区里相互独立的 DSH 会话，同时互读交接文档。**

> 社区非官方插件，与 DeepSeek 官方无隶属或背书关系。

## 项目分工（模型归属）

- **代码实现**：`deepseek-v4.1-flash`（DeepSeek Harness lead agent，opencode 路由），2026-11-10。
- **首轮稳定性审查**：`deepseek-v4.1-flash`（另开的同模型子代理，fresh context）。
- **独立发布审查**：`gpt-6.1-sol`，经 Codex 子代理（`subagent_codex`，reasoning effort `ultra`）。
- **产品方向、环境与验收**：仓库所有者。

模型名称只说明本次发布使用的工具；审查是建议性的，不代表任何模型提供方的背书。详见 [CREDITS.md](CREDITS.md)。

多个模型会话在同一工作区并行时，每个会话都会写交接文档，但很少有人去读别人
最新的那一份。Handoff Hub 提供一个很小的共享“交接室”和一个持久化操作：同时
提醒所有同伴读取当前交接文档，并更新自己的那一份。

它**不是**工作流引擎、任务看板或记忆系统；它只协调你已经在用的交接文件，
不强制格式。

## 功能

- `handoff_board`：只读列出交接室、已登记同伴、各自文档的绝对路径/大小/更新时间，
  以及同工作区未登记的活跃会话（含标题）。
- `handoff_join`：登记本会话并原子写入自己的交接文档；校验重名、文档归属、
  路径穿越、大小与 Windows 保留名。
- `handoff_nudge`：为每个目标创建一个**持久化的一次性 Schedule 任务**，近同时
  提醒对方读同伴文档、更新自己并重新登记；可附加最多 5 个参考文档路径
  （例如使用指南）。
- `handoff_leave`：只移除本会话的登记，不删除交接文档。

插件自身不调用任何模型 API。它通过 DSH 内置的 `ctx.schedule` 服务排入一条普通
用户消息；目标会话用自己的模型处理这条消息。

## 安装

要求：DeepSeek Harness `>= 0.2.2-rc.1`，Node.js 22.19+ 或 24+，以及一个包含
待协调会话的工作区。

克隆或下载本仓库：

```bash
git clone https://github.com/LiFePO2/dsh-handoff-hub.git
```

然后让 DSH 代理安装本地包：

```text
plugin_manager install_bundle target=<克隆目录的绝对路径>
```

路径含空格时请加引号，例如 `target="D:\plugins\dsh-handoff-hub"`。

`plugin_manager` 需要 full-access 审批。bundle 会插入一行 `handoff-hub`；
激活后四个工具对所有 agent 可见。该包尚未发布到 npm，本地目录安装是当前
支持的方式。

> **Profile 包管理器警告**：安装任何 DSH bundle 都会在 profile 里执行包管理器。
> 如果你手动替换过 profile `node_modules` 里的包（例如自定义 `@openai/codex`
> payload），请先备份或固定版本。本插件自身没有依赖，不会改动它们。

## 快速开始

每个协作会话登记一次：

```text
handoff_join
  name: "codex"
  doc: "2026-11-10-codex.md"
  content: "# 交接：codex\n\n## 当前状态\n...\n"
```

任意会话随后：

```text
handoff_board       # 看谁已登记、文档在哪
handoff_nudge       # 让所有已登记同伴现在同步
```

显式提醒某个会话（无需先登记，仍会做同工作区审计）：

```text
handoff_nudge
  targets: ["session-..."]
  note: "继续之前请先读使用指南。"
```

给所有目标附带一份参考文档：

```text
handoff_nudge
  references: ["work/handoff-hub/plugin/README.md"]
```

会话结束时：

```text
handoff_leave
```

## 投递语义

`handoff_nudge` 为每个目标创建一个 `target.kind = "session"`、
`timing.kind = "after"` 的一次性 Schedule 任务：

1. Schedule 在不加载会话的情况下校验目标并持久化任务；
2. 到点后解析目标 Agent（必要时恢复会话），以用户消息调用 `agent.followup()`；
3. 目标忙则排队，空闲则唤醒；
4. 任务在 DSH 重启后仍在；排队中的投递由 Schedule 服务恢复。

工具返回的是**排队回执**，不是“已读”：

```text
[交接中枢] 已向 3/3 个会话排期交接同步提醒（延迟约 1 秒）。
- codex：已排期 · 任务 schedule-... · 触发时间 ...
- qwen：已排期 · 任务 schedule-... · 触发时间 ...
- stale-peer：失败 · [session_not_found] target Session does not exist
```

另外需要知道：

- 每个目标还会收到一条 Schedule 服务自动生成的、无需处理的
  `[SCHEDULE CHANGE]` 创建通知；真正的提醒是第二条消息。
- 提醒正文在 Schedule 框架里以 JSON 字符串承载，换行显示为 `\n`；模型可正常阅读。
- 一条提醒会消耗目标会话一次模型回合，这是“提醒”的预期代价。

## 配置

bundle 的 patch 自带默认值；可在 profile 的 `cordis.patch.yml` 里用同 id 的
行覆盖：

```yaml
- id: handoff-hub
  name: 'dsh-handoff-hub'
  config:
    directory: 'work/handoff'   # 绝对路径，或相对调用方 cwd
    promptLanguage: 'zh'        # zh | en
    nudgeDelaySeconds: 1        # 1..60
    maxRecipients: 16           # 1..32
    maxDocBytes: 262144         # 4 KiB..4 MiB
    cleanupEndedTasks: false    # 见下，默认关闭
```

`cleanupEndedTasks` 会在 nudge 前删除本插件已结束的任务；但 Schedule 服务删除
任务时会向相关活跃会话注入一条 `[SCHEDULE CHANGE]` 无操作通知，所以默认关闭。

## 磁盘状态

```text
<workspace>/work/handoff/
  <model-a>.md
  <model-b>.md
  .handoff-hub/
    participants/
      session-<uuid>.json      # 每会话一个原子登记文件
```

登记项：

```json
{
  "v": 1,
  "sessionId": "session-...",
  "name": "codex",
  "doc": "2026-11-10-codex.md",
  "cwd": "E:\\LAB\\DS GPT\\T1",
  "joinedAt": "2026-11-10T06:20:00.000Z",
  "updatedAt": "2026-11-10T06:20:00.000Z"
}
```

删除某个登记文件即可让该会话退出；插件永远不会删除或改写他人的文档。

## 安全模型

- **目标用持久化 Session 存储复核**：`ctx.sessionPersistence.stat()` 必须存在、
  非委派子会话、且 `header.cwd` 与调用方工作区一致；被篡改的名单无法把提醒
  投到其他工作区。
- **名单按不可信输入读取**：重新校验文档名（拒绝 `..`、路径分隔符、保留名），
  清洗显示名；坏条目跳过并告警。
- **名字与文档名大小写不敏感比较**，符合 NTFS 行为，避免 `Lead.md` 与
  `lead.md` 互相覆盖。
- **文档与请求方附言都被标注为证据/参考，不是指令**；提醒明确说明请求方是
  模型会话，不是用户本人。
- **参考文档路径**会解析符号链接，拒绝工作区之外的文件，只允许小体量的
  `.md`/`.markdown`/`.txt`。

## 稳定性

- 无定时器、无 fs.watch、无轮询、不写 session event、不注册 system prompt section；
- 全部工具注册由一个 `ctx.effect()` 持有，卸载即注销；
- 每个目标独立 `Promise.allSettled`，单个失效目标不影响整批；
- `tmp + rename` 原子写，Windows 短暂占用时有限重试；
- 输入输出全部设上限；
- 运行时零第三方依赖，只用 Node 内置模块。

## 已知限制

- 每个同伴需先登记，或在 `targets` 中显式指定；不会自动打扰未登记会话。
- 读取是异步的、没有确认机制；插件无法证明某个会话真的读了文档。
- 两个会话同时用同一个新文档名登记时，房间锁会把插件内的 join 串行化，第二个
  join 会收到 `doc_taken`；但外部写入仍可能与 join 竞争，此时是 last-writer-wins，
  `handoff_join` 检测到重复归属时会给出 `[roster_conflict]` 警告。
- 已结束的 Schedule 任务会累积，除非开启 `cleanupEndedTasks`；它们只是任务
  列表里的无害记录。
- 需要工单、flow 接力、看板时请用 [`dsh-collab`](https://github.com/sessionhive/dsh-collab)。

## 卸载

移除 bundle（或禁用该行）即可。交接室目录、交接文档和登记文件都会保留。
**已经排入 Schedule 服务的提醒是持久化的，卸载后仍可能被投递**；如果不希望
它们送达，请到 Automation tasks 页面删除对应任务。

## 兼容性

| 组件 | 状态 |
|---|---|
| DSH | 以 `0.2.2-rc.1` 测试；要求 `>= 0.2.2-rc.1 < 0.3.0` |
| Node.js | 以 22.19 与 24 测试；CI 两个版本都跑 |
| 操作系统 | Windows 10/11 实测；无原生代码，Linux/macOS 预期可用但未在 CI 覆盖 |
| 模型 | provider 无关：插件自身不调用模型 API，会话原本用什么模型都能参与 |

## 相关项目

- [`dsh-collab`](https://github.com/sessionhive/dsh-collab)：工单、flow 交接、
  文件记忆与看板。
- [`dsh-handoff-bus`](https://www.npmjs.com/package/dsh-handoff-bus)：GUI 会话间
  消息总线。
- [`dsh-handoff-session`](https://www.npmjs.com/package/dsh-handoff-session)：
  上下文压力感知的会话交接。
- [`dsh-auto-handoff`](https://www.npmjs.com/package/dsh-auto-handoff)：长会话摘要
  并在新会话继续。

## 开发

```bash
node test/manifest.mjs
node test/harness.mjs
```

离线测试使用 mock Cordis 上下文与真实临时目录，覆盖注册、名单校验、篡改条目、
重名、路径穿越、目标审计、失败隔离、参考文档、退出与卸载。CI 在 Node 22/24
运行这两个文件。

## 许可

MIT，见 [LICENSE](LICENSE)。
