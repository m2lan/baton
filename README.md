# LocalBot

![preview](assets/preview.png)

把**本机已经装好的 AI CLI** 变成一支有名字、有头像、有记忆的 Bot 团队。思路照搬 Grok Bot，但"Bot 的电脑"换成你自己的电脑，"模型"换成本机任意一个 CLI。

> Grok Bot 的核心是：Bot 是同事，不是工具。给它一个名字、一台电脑、一个长期会话，然后把活丢过去。
> LocalBot 保留这套交互，把执行体从 xAI 的云电脑换成 `claude` / `codex` / `gemini` / `codebuddy` … 这些你已经付过钱的本地 CLI。

## 快速开始

```bash
npm install
npm start
```

Windows 上也可以直接双击 **`start.bat`**（会自动装依赖）。

首次启动会自动扫描 PATH 里的 AI CLI，识别到几个就能用几个。点右上角 **＋** 选一个 CLI，起个名字，就可以开聊。

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 一个 Bot = 一个 CLI | 同一个 CLI 可以建多个 Bot，分别绑不同工作目录和角色设定 |
| 真流式 | 直接解析 CLI 的 `stream-json` / JSONL 输出，文字边生成边显示 |
| 工具可见 | 读文件、跑命令、改代码都以卡片展示，可展开看完整输入输出 |
| 会话延续 | 记住 CLI 的 session id，下一轮自动 `--resume`，上下文不断 |
| 多 Bot 并行 | 每个 Bot 独立进程，切走不中断，侧边栏有小绿点表示在跑 |
| 工作目录 | Bot 的所有文件操作限定在你指定的目录 |
| 角色设定 | 每轮自动注入，用来固定人设/分工 |
| 权限模式 | 自动 / 谨慎 / 只读，映射到各 CLI 自己的权限参数 |
| 一键安装 | 没装的 CLI 在弹窗里点"安装"就装（npm / 官方脚本），日志实时回显 |
| 窗口内登录 | 底部内嵌真终端（node-pty + xterm.js），CLI 的交互式授权直接在应用里完成，不用跳外部终端 |

## 已内置的 CLI

装了就能用（自动探测版本）：`claude`、`codebuddy`、`codex`、`gemini`、`opencode`、`copilot`、`grok`。

未安装但支持一键装：Qoder（跳官网）、Cursor CLI、Qwen Code、Amp、Aider。

每个 CLI 的输出协议差异由 `electron/parsers.js` 抹平：

- `claude` / `codebuddy` → `--output-format stream-json --include-partial-messages`
- `codex` → `codex exec --json`（+ `resume`）
- `gemini` → `-o stream-json`
- `opencode` → `run --format json`
- 其它 → 通用解析：能认出 JSON 事件就抽文本，认不出就当纯文本流

## 加一个新的 CLI

编辑 `electron/agents.js` 里的 `CATALOG`，加一条：

```js
{
  id: 'mycli',
  name: 'My CLI',
  emoji: '🧪',
  color: '#8888ff',
  bin: 'mycli',                 // PATH 里的可执行文件名
  proto: 'generic',             // claude | codex | gemini | opencode | generic
  stdinPrompt: false,           // prompt 走 stdin 还是 argv
  session: false,               // 支不支持续聊
  permission: false,
  install: { kind: 'npm', pkg: 'my-cli' },
  login: 'mycli login',
  models: [],
}
```

如果它的输出是结构化 JSON，在 `parsers.js` 里加一个 `xxxParser`，注册到 `createParser` 即可。不改也能用，只是变成纯文本渲染。

## 目录结构

```
electron/
  main.js       窗口、IPC、安装流程
  agents.js     CLI 目录 + 每种 CLI 的命令行拼装
  parsers.js    各 CLI 输出协议 → 统一事件
  runner.js     进程管理、流式组装、会话 id 回传
  store.js      bots.json / chats/*.json 持久化
  preload.js    contextBridge 暴露的白名单 API
renderer/
  index.html    Vue3 模板（无构建，本地 vendor）
  app.js        状态、事件订阅、markdown 渲染
  style.css     深色主题
scripts/
  test-runner.js  命令行验证某个 CLI 适配器是否跑通
  make-icon.js    重新生成应用图标
```

数据存在 `%APPDATA%\LocalBot\data\`（macOS/Linux 在对应 userData 目录），删掉即重置。

## 排错

```bash
# 单独验证某个 CLI 适配器（不开界面）
node scripts/test-runner.js claude "用一句话介绍自己"
node scripts/test-runner.js codex  "回复 ok"
```

- **提示未登录**：点消息里的"在窗口内登录"，底部会拉起该 CLI 的交互式终端（claude 系会给出"输入 /login"按钮），授权完成后关掉面板、把消息重发一次即可。
- **提示找不到 CLI**：说明它不在 PATH 里，用弹窗里的"安装"或自己装完后点"刷新"。
- **一直是空输出**：多半是该 CLI 的 `proto` 猜错了，先用 `test-runner.js` 确认原始输出格式。

## 已知边界

- 目前是**单机、单用户**：没有云电脑、没有手机端、没有 Bot 之间的群聊路由（Grok Bot 的群聊是靠云端调度，本地版要另做一层消息总线）。
- 权限审批是**事前模式选择**，不是 Grok Bot 那种"执行到一半弹卡片让你点同意"。原因是 CLI 的非交互模式无法中途接管；要审批就用 `plan`/`谨慎` 模式，或者换成 CLI 的交互模式另做 PTY 层。
- 长任务不会自动超时，进程随窗口关闭一起 kill。
