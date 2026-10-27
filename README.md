# Baton

**English** · [简体中文](README.zh-CN.md)

![preview](assets/preview.png)

Turn the AI CLIs already installed on your machine into a team of named Bots.

> Grok Bot's insight was that a Bot is a colleague, not a tool: give it a name, a computer, a long-lived conversation, then hand it work.
> Baton keeps that interaction and swaps out the execution layer — instead of xAI's cloud computer, each Bot runs the `claude` / `codex` / `gemini` / `codebuddy` CLI you already have installed and already pay for.

## Why

You probably have three or four agent CLIs on your laptop. Each one is good at something, and each one forgets everything when you close the terminal. Switching between them means losing context, re-explaining your project, and losing track of what was done where.

Baton gives each CLI an identity — a name, an avatar, a working directory, a session that survives restarts — and a shared room where they can hand work to each other.

## What it does

| | |
| --- | --- |
| **One Bot = one CLI** | The same CLI can back several Bots with different directories and personas |
| **Real streaming** | Parses the CLI's `stream-json` / JSONL output; text appears as it is generated, not after |
| **Visible tool calls** | Reads, commands and edits show up as cards you can expand to see full input/output |
| **Session continuity** | Records the CLI's session id and `--resume`s on the next turn, across app restarts |
| **Parallel Bots** | Each Bot is its own process; switch away and it keeps working (green dot in the sidebar) |
| **Per-Bot working directory** | All file operations are scoped to the directory you assign |
| **One-click install** | Missing CLIs install from inside the app (npm or the official script), with live logs |
| **In-window login** | An embedded real terminal (node-pty + xterm.js) so interactive OAuth happens inside the app |
| **Group chat** | Multiple Bots in one room: `@name` to address someone, an `@` in a reply hands the work over |
| **Fast startup** | PATH scan returns in ~60ms; versions are cached and filled in concurrently in the background |
| **Auto-update** | Packaged builds check GitHub Releases and install updates in place |

## Quick start

```bash
npm install
npm start
```

On Windows you can also double-click **`start.bat`** (it installs dependencies on first run).

On first launch Baton scans your PATH for supported CLIs. Click **＋** in the top-right, pick a CLI, name the Bot, and start talking.

## Built-in CLIs

Anything on your PATH that can take a prompt and print a response works. These have tested adapters:

| CLI | Notes |
| --- | --- |
| Claude Code (`claude`) | stream-json, `/login` inside the app |
| CodeBuddy (`codebuddy`) | stream-json; needs a free local port (see below) |
| Codex (`codex`) | `codex exec --json` |
| Gemini CLI (`gemini`) | `-o stream-json` |
| OpenCode (`opencode`) | `run --format json` |
| GitHub Copilot (`copilot`) | text mode |
| Grok CLI (`grok`) | text mode |
| Qwen Code (`qwen`) | Gemini-style output |
| Cursor Agent (`cursor-agent`) | text mode |
| Amp (`amp`) | text mode |
| Aider (`aider`) | text mode, auto-commits |
| Qoder | manual install, website only |

## Adding a CLI

One entry in `electron/agents.js`:

```js
{
  id: 'mycli',
  name: 'My CLI',
  emoji: '🛠️',
  color: '#7c6bff',
  bin: 'mycli',            // executable name on PATH
  proto: 'claude',         // claude | codex | gemini | generic
  stdinPrompt: true,       // pipe the prompt via stdin instead of argv
  session: true,           // supports --resume
  permission: false,
  login: 'mycli auth',
  install: { kind: 'npm', pkg: 'mycli' },
}
```

If the output format doesn't match any existing parser, add one in `electron/parsers.js` and verify it standalone:

```bash
node scripts/test-runner.js mycli "say hello"
```

## Group chat

Put several Bots in one room. The rules are deliberately simple and predictable:

1. **`@` addresses someone.** Whoever you mention answers, in order, serially — the next one sees what the previous one produced.
2. **No mention → the lead answers.** Pick a lead in the room settings; it can `@` someone else if it needs help.
3. **An `@` in a reply is a handoff.** That member gets woken up to continue. **The same Bot can take over repeatedly**, so a cycle like "draft → review → revise → re-review" runs itself to completion.
4. **When it stops:** a reply that mentions nobody means the job is done, and the turn ends naturally. There is no per-Bot cap. Three fuses keep it from running away:
   - **Per-run timeout** — a single call that exceeds 5 minutes is killed and explained (`BATON_RUN_TIMEOUT_MS` to change)
   - **No progress** — if the same Bot says essentially the same thing twice in a row, it counts as spinning and stops
   - **Hop limit** — 60 hops, purely an outer fuse

While a room is busy, a bar above the composer shows **who is running and who is queued**, so you never have to guess which step you are on.

Context: every Bot keeps its **own session** in the room (so it remembers its own work), and each prompt adds three layers of what it cannot see:

| Layer | Content | Budget | Why |
| --- | --- | --- | --- |
| ① Your requirements | Every message you sent | 1500 chars | Your messages are short and all signal — losing them derails the work |
| ② Conclusions | The tail of each other Bot's last out-of-window reply, plus its `@` handoff line | 1600 chars | Conclusions land at the end; the process chatter in between can go |
| ③ Recent turns | The last 10 messages in full | 3000 chars | Keeps the thread coherent |

The three layers never overlap: your messages only go in ①, in-window Bot replies only in ③, and only out-of-window ones get summarised into ②. **Budget is allocated by importance, not by recency** — so no matter how long the thread gets, the requirement you stated at the start and the decisions made along the way are never pushed out.

A room can either share one working directory (recommended when they edit the same repo — otherwise one Bot literally cannot see the file another just changed) or let each Bot stay in its own.

## Project layout

```
electron/
  main.js       window, IPC, install flow, auto-update
  agents.js     CLI catalog + command line construction
  parsers.js    each CLI's output protocol → unified events
  runner.js     process management, streaming assembly, session ids
  store.js      bots.json / chats/*.json persistence
  room.js       group chat orchestration (@mentions, handoffs)
  pty.js        embedded terminal (node-pty sessions)
  detect.js     CLI detection (fast scan + background version fill)
  net.js        proxy policy per CLI
  platform.js   the only place with Windows/macOS/Linux branches
  preload.js    contextBridge whitelist
renderer/
  index.html    Vue 3 templates (no build step, vendored runtime)
  app.js        state, event wiring, markdown rendering
  style.css     dark theme
build/          icon + macOS entitlements
scripts/        dist.js (packaging), test-runner.js, make-icon.js, bench-detect.js
.github/        three-platform CI
```

Data lives in the userData directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\Baton\data\` |
| macOS | `~/Library/Application Support/Baton/data/` |
| Linux | `~/.config/Baton/data/` |

Delete `data/` to reset. (Upgrading from the old `LocalBot` name migrates data automatically on first launch.)

## Auto-update

Packaged builds check GitHub Releases on startup (and on demand from **⚙ → About**). The flow:

1. CI builds on a `v*` tag and uploads artifacts plus `latest.yml` to a **draft** release.
2. You review the draft and press **Publish release**.
3. Installed clients see the new `latest.yml`, download in the background, and offer **Restart and install**.

Point `repository.url` in `package.json` at your repo — electron-builder infers the GitHub publish target from it. Forks need no edits: in CI the URL is rewritten from `GITHUB_REPOSITORY`.

> Note: do **not** add a `build.publish` array. electron-builder 26 has a schema defect where `GithubOptions` references an undefined `$ref`, so any explicit `publish` array fails validation with `publish.0.provider must be equal to constant`. Inference from `repository` works fine.

Unsigned builds still auto-update, but users get a SmartScreen / Gatekeeper warning on first launch. See [Code signing](#code-signing).

## Packaging

```bash
npm run pack        # unpacked directory only (quick sanity check)
npm run dist:win    # Windows: NSIS installer + portable exe
npm run dist:mac    # macOS: dmg + zip (must run on macOS)
npm run dist:linux  # Linux: AppImage + deb
npm run dist        # current platform
```

Artifacts land in `release/`.

### Why builds must run on each platform

| Constraint | Consequence |
| --- | --- |
| `dmg` needs `hdiutil` and Apple's signing tools | macOS artifacts can only be produced on macOS |
| `@lydell/node-pty` ships per-platform prebuilt binaries via `optionalDependencies` | `npm install` only fetches the host's binary — cross-building produces a package whose terminal crashes on the user's machine |

`scripts/dist.js` checks the target platform's native module before building and tells you exactly which package to install rather than silently producing a broken build. The CI matrix handles this by running `npm ci` on each platform.

Cross-architecture (e.g. arm64 from an x64 machine):

```bash
npm i -D --no-save @lydell/node-pty-win32-arm64@1.2.0-beta.18
node scripts/dist.js --win --arch=arm64
```

### Intel Macs

The `macos-x64` CI job is **opt-in** (unchecked by default). GitHub is retiring the `macos-13` runners and they queue for a long time, which blocks the whole workflow. Trigger the workflow manually and tick *build_intel* when you need one, or build locally:

```bash
node scripts/dist.js --mac --arch=x64
```

### Code signing

**Unsigned builds install and auto-update fine** — there is just one extra click on first launch:

| Platform | What users see | How to get past it |
| --- | --- | --- |
| Windows | SmartScreen: "Windows protected your PC" | More info → Run anyway |
| macOS | "Cannot be opened because the developer cannot be verified" | Right-click the app → Open, or `xattr -dr com.apple.quarantine /Applications/Baton.app` |

If that warning bothers you, you need a certificate. Three realistic options:

| Option | Best for | Notes |
| --- | --- | --- |
| **SignPath** (free for OSS) | Open-source projects | Free Windows signing for qualifying OSS projects; requires an application and review |
| **Azure Trusted Signing** | Individuals / small teams | Microsoft's cloud signing, monthly fee, no hardware token; individual accounts need identity verification |
| **Traditional OV / EV certificate** | Companies | Requires a registered business. Since 2023 these usually ship on a hardware token or cloud HSM, so **the private key cannot be exported** — `CSC_LINK` does not apply; use the certificate store or the vendor's cloud signing instead |

> For a personal open-source project, **not signing is a perfectly reasonable choice**. Put the two bypass steps in your release notes. Spend money when people actually report being blocked, or when you need internal distribution at a company.

#### Wiring a certificate into CI

Once you have a `.pfx` (Windows) or `.p12` (macOS):

```bash
# GitHub secrets only hold text
base64 -w0 cert.pfx > cert.b64        # macOS: base64 -i cert.pfx -o cert.b64
```

Then add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Contents of `cert.b64` (a `https://` or `file://` URL also works) |
| `CSC_KEY_PASSWORD` | Password set when exporting the certificate |
| `APPLE_ID` | macOS notarization only |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarization only (generate at appleid.apple.com) |
| `APPLE_TEAM_ID` | macOS notarization only |

The workflow already forwards all of these to `dist.js`, so no code changes are needed — the next tagged build will be signed.

macOS entitlements live in `build/entitlements.mac.plist` (JIT, unsigned executable memory, disabled library validation — required for node-pty's `.node` binary). Providing the three `APPLE_*` variables is enough for electron-builder to notarize automatically.

## Network and proxy

Default policy is **smart**, per CLI — never one-size-fits-all:

| CLI | Policy | Why |
| --- | --- | --- |
| Overseas (claude / gemini / codex / copilot / amp) | **inherit system proxy** | These accounts are tied to a region; suddenly going direct changes your egress IP and can trigger risk controls or bans |
| Domestic (codebuddy / qwen) | **direct** | Their `setProxy` throws on proxy env vars, which surfaces as `socket disconnected before secure TLS connection` |
| npm install | inherit system proxy | Otherwise installs fail |

**⚙ → Settings** lets you switch between smart / inherit / direct / custom, override a single CLI, and run a TLS handshake diagnostic against the three key domains.

> ⚠️ Unless you are certain your network needs no proxy, never switch the overseas CLIs to direct.

## Port conflict

`codebuddy` uses a stable local daemon port (`61172`) that the **WorkBuddy / CodeBuddy desktop app usually already owns**.

- Non-interactive runs get a free port automatically via `--port`, so normal chatting is unaffected.
- Interactive login cannot take `--port` (the CLI exits silently), so when the port is taken the terminal explains it and suggests closing the host app or using the external terminal.

## Troubleshooting

```bash
# verify one CLI adapter without opening the UI
node scripts/test-runner.js claude "introduce yourself in one sentence"
node scripts/test-runner.js codex  "reply ok"

# measure CLI detection time
node scripts/bench-detect.js
```

- **"Not logged in"** — click *Login in window* on the message. A terminal opens at the bottom; for claude-family CLIs there is an *Input /login* button. Finish auth, close the panel, resend.
- **CLI not found** — it is not on PATH. Use the install button, or install it yourself and hit refresh.
- **Empty output** — the `proto` is probably wrong. Check the raw output with `test-runner.js`.
- **TLS / socket disconnected** — check the diagnostic in Settings first. Domestic CLIs need direct; overseas CLIs need a working proxy, not direct.
- **Port 61172 already in use** — close the WorkBuddy / CodeBuddy desktop app, or use the external terminal.
- **Installed build does nothing on launch** — there is no console in a packaged app; errors go to `crash.log`:

  | Platform | Path |
  | --- | --- |
  | Windows | `%APPDATA%\Baton\crash.log` |
  | macOS | `~/Library/Application Support/Baton/crash.log` |
  | Linux | `~/.config/Baton/crash.log` |

## Limitations

- **Single machine, single user.** No cloud computer, no mobile client. Group chat is locally serialised (one member runs at a time), not cloud-scheduled.
- **Approval is up front, not mid-run.** Grok Bot can pause and ask you to approve a step; a non-interactive CLI subprocess cannot be taken over mid-flight. Pick the permission mode before you send, or use the CLI's interactive mode.
- **The interface is currently Chinese only.** Documentation is bilingual; an English UI is on the roadmap.
- **Windows is the only platform tested so far.** The macOS/Linux branches (PATH locations, system terminal, install interpreters) are written against each platform's conventions and the packaging config is in place, but they have not been run on real hardware. First macOS build should verify the embedded terminal and the external terminal.
- Running tasks never time out; they die with the window.

## License

MIT
