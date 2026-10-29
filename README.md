# dsh-tool-interrupt

DSH 插件：**单工具级手动中断**。会话运行时，点「后台任务」菜单里某一行的停止按钮，不再直接杀任务，而是先弹出一个「为何中断」小窗——填写理由（可留空）确认后，**只中断该次工具调用**，理由作为该次调用的工具结果回传给模型，模型在同一回合内据此调整计划。**会话与回合不中断**。

English summary: per-tool-call manual interrupt for DeepSeek Harness. The session-header background-jobs menu's row stop button opens a minimal "为何中断" (why interrupt) dialog instead of killing the task outright; confirming aborts only that one tool call and hands the reason to the model as that call's tool result, so the turn continues.

## 功能

- 🎯 **单调用粒度**：只中断所选的那次工具调用；并行批次中的其他调用不受影响
- 💬 **理由回传**：模型在同一回合读到「【用户手动中断】中断理由：…」并据此调整；未填理由则回传「【用户手动中断】未提供理由」
- 🔁 **会话不中断**：中断被转换为该调用的错误工具结果（而非异常），回合照常继续
- 🖌 **原生入口**：接管 DSH 自带「后台任务」菜单行停止按钮的第一击；纯后台 job（非模型工具调用）仍走原生两段式确认，行为不变
- 🌗 **亮暗主题**：全部使用 DSH 主题 token（`--dsw-alias-*`），亮/暗自动适配
- ⌨️ 快捷键：`Esc` 关闭窗体，`Ctrl/Cmd + Enter` 提交

## 安装

```sh
dsh plugin --profile web add github:wlyzqm/dsh-tool-interrupt
```

安装后完整重启 `dsh web`，并刷新浏览器页面。

## 使用

1. 会话运行期间，点会话顶部的「后台任务」（N 个后台任务运行中）
2. 点目标行右侧的停止小方块
3. 弹出「为何中断」窗体 → 填写理由（可留空）→ 点「中断」
4. 该工具调用立即结束；模型收到带理由的工具结果，同回合继续

## 工作原理

- 宿主半通过官方 `tools/execute` around-dispatch waterfall 给每个派发的工具调用替换独立 `AbortController` 信号（与官方 `dsh-tool-call-timeout-policy` 同构）。
- 用户中断时只 abort 该调用的信号：运行时把中止转换为该调用的错误**结果**（不是异常），步骤照常提交——这是"会话不中断"的关键。
- 模型调用映射：前端轮询 `GET /dsh-tool-interrupt/in-flight`，点击停止按钮时按行命令文本匹配在途调用；命中则接管，未命中放行原生行为。
- 亮暗主题：卡片底色 `--dsw-alias-bg-layer-1`，破坏性按钮沿用官方 jobs 停止按钮的 error 语义配色。

## 已知边界

- 不响应中止信号的极少数工具：中断会在其自然结束时生效（运行时契约「Cancellation never abandons the body」）。
- `run_code` 嵌套子派发不参与匹配（只接管顶层工具调用）。
- 若未来 DSH 改动「后台任务」菜单 DOM（`data-kill-state` 选择器），F12 控制台的 `[dsh-tool-interrupt] stop pressed { label, cached, matched }` 日志可用于定位。

## 开发

```sh
npm run check   # node --check 两个入口
```

## License

MIT
