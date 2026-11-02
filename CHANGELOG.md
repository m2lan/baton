# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.8.0] - 2026-11-02

### Added

- **任务级 worktree**：串行群聊任务整条链共用一个 detached worktree，成员依次在里面工作；成功结束后自动把改动合回主目录（未提交），失败 / 阻塞 / 停止保留现场，并在会话里给出路径。
- 合并失败时任务标记为 `mergeFailed`，隔离目录保留，提示手动对比 / 合并；启动清理会跳过任何仍被任务引用的 worktree。
- **Runs 默认只看需要人处理的任务**：中断、阻塞、失败类（`error` / `stall` / `timeout` / `maxTurns` / `verifyFailed` / `mergeFailed`）默认显示，带计数徽标；「全部」用于查历史。
- `scripts/test-worktree.js`：真 git 仓库覆盖成功合并、阻塞保留、非 git 跳过、成员目录不一致跳过、启动清理不误删。

### Changed

- `needsAttention()` 统一判定，`runs:list` 每条任务都带 `needsAttention`。
- 中断恢复说明会提示上一轮遗留的隔离目录路径。

### Known limitations

- 任务级 worktree 只用于**串行群聊任务**：单 Bot 没有并发冲突，隔离收益低；并发批沿用按人 worktree。
- 群成员各自有独立 cwd 时无法统一隔离，自动退回原目录执行。

## [0.7.0] - 2026-11-02

### Added

- **结构化「等人」信号**：群聊 prompt 新增两个输出标记。
  - `【阻塞】原因`：必须由用户补充信息、给权限或做决定才能继续时使用。Baton 会停在当前成员，不交班、不再跑后续成员、跳过验收，并在会话里留一条可读的停机提示。
  - `【待确认】说明`：按某个假设继续、但希望用户事后确认时使用。不打断交班，整轮结束时汇总一条提示。
- **阻塞状态可见**：会话顶部提示条显示「任务在等你：原因」，按钮为「知道了」；Runs 里显示「等待你处理」。并发批里任何一个成员阻塞，整轮都会停下。
- `scripts/test-blocking.js`：覆盖标记解析、阻塞停机、跳过验收、待确认不阻断、并发批阻塞、「知道了」幂等。

### Changed

- 会话顶部状态从「中断」扩展到「中断 / 阻塞」两类，统一由 `attention` 管理。
- 新增 `runs:dismiss` IPC 与 `dismissAttention()`：只影响提醒，不改任务终态。

### Notes

- 阻塞与中断语义不同：中断是进程没了，点「继续」还原未开始的成员；阻塞是 Bot 明确做不下去，用户补充信息后发的是**新任务**，旧队列不重放。

## [0.6.0] - 2026-11-02

### Added

- **任务开始即落盘**：进行中的任务写入 `data/runs/live/<key>.json`，状态变化时原子写；完成后自动清理，正常退出不留快照。
- **中断归档与恢复**：启动时把上次残留的运行中任务归档为 `interrupted`（`endReason: hostExit`），保留已完成的跳、用量和未开始的交接队列。中断任务计入用量汇总。
- **群聊任务可继续**：Runs 面板与会话顶部提示条都提供「继续」，只还原还没接手的成员，首跳 prompt 注入【继续上次中断的任务】，要求接手方先核对 `git status` 和相关文件，不假装断点续跑。
- **会话顶部中断提示条**：不打开 Runs 也能看到上次任务中断，并直接继续或不再提醒。
- **Runs 里的中断状态**：任务卡片显示「已中断」标签、已完成的接力图和文件改动。
- `scripts/test-recover.js`、`scripts/test-shutdown.js`：覆盖落盘、归档、幂等、旧一轮迟到收尾、退出时半截消息落盘。

### Changed

- 退出流程统一到 `before-quit`：先 `Runner.drain()` 保住正在流式输出的消息，再 `runlog.interruptAll()` 归档任务，最后退出；5 秒兜底。
- `Task` 增加 `status` / `updatedAt` / `interruptedAt` / `round`，历史任务会带 `completed` 或 `interrupted` 终态。
- 群聊轮次快照（turn / notes / verifyAttempts / 当前成员 / 未开始队列）随状态变化写入 live 快照。

### Fixed

- 旧一轮迟到的 `finish()` 不会删掉新一轮的 live 快照，迟到的状态更新也不会覆盖新快照（按 task id 校验归属）。
- `scripts/test-attach.js` 用 `/etc/passwd` 验证路径越界，在 Windows 上必然失败；改为临时目录里真实存在的文件，语义不变且跨平台。

### Known limitations

- 任务管理器强杀进程时，任务记录、已完成跳和未开始队列能保住，但**当前正在流式输出的半截文本会丢**——`drain()` 只覆盖关窗 / 菜单退出这类优雅退出。
- 单 Bot 的中断任务只显示状态，不提供「继续」；重发一句即可。

## [0.5.0] 及更早

见 Git 提交历史。