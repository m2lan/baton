# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

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