# Pulse

Desktop widgets for your Claude and Codex usage limits. Pin any limit as a slim floating bar that sits on your desktop, updates itself, and warns you before you hit the wall.

- Live usage bars for every limit on your plan: Claude from the same endpoint claude.ai uses, Codex from the local `codex app-server`
- Pin any bar as a frameless always-on-top desktop widget. Drag it anywhere, resize it, keep as many as you want
- Desktop notifications when a limit crosses 75%, 90%, and 100%
- Tray icon with at-a-glance percentages in the tooltip
- No accounts, no configuration files to write. The only network request is the usage call to `api.anthropic.com`; Codex numbers come from your local Codex install

## Requirements

- Windows, macOS, or Linux (prebuilt downloads on [itch.io](https://formslip.itch.io/claude-pulse))
- [Node.js](https://nodejs.org) 18+ (only if running from source)
- For Claude: [Claude Code](https://claude.com/claude-code) signed in at least once. Pulse reads the OAuth token Claude Code already saved (`~/.claude/.credentials.json`, read-only) and uses it to ask Anthropic for your usage numbers. Nothing else is done with it.
- For Codex: [Codex](https://chatgpt.com/codex) installed and signed in with the ChatGPT account you want to monitor. Pulse asks `codex app-server` for `account/rateLimits/read` and nothing else. Codex keeps its own authentication; Pulse never copies its tokens or sends prompts. Either provider is optional: with only one installed, you only see that one.

macOS note: the app is unsigned. If macOS blocks it, right-click → Open, or allow it under System Settings → Privacy & Security. Downloads through the [itch app](https://itch.io/app) avoid this entirely.

## Quick start

```
npm install
npm start
```

The dashboard opens; closing it minimizes to the tray. Quit from the tray icon.

## Using it

- **Pin a widget**: hit "pin as widget" under any usage bar in the dashboard. Every limit the account service returns is pinnable, including Codex's gpt-reserve and GPT-5.3-Codex-Spark windows.
- **Move / resize**: drag a widget with the drag button (default: right mouse). Drag near the right edge to resize.
- **Always-on-top**: use the "on top" checkbox in the dashboard's widget list. Pinned widgets recover their z-order every few seconds and after resume, unlock, and display changes, without stealing focus.
- **Remove**: click a widget with the delete button (default: middle mouse), or the ✕ in the dashboard list.
- **Hover** a widget to see time until reset. The tooltip has the full limit name.

Claude widgets are blue. Codex widgets have a mint border and a CODEX badge.

### Percent display

Claude's own `/status` reports percent **used**. Codex's reports percent **left**. Side by side that reads backwards, so Settings has a **Percent display** option:

| Mode | Claude shows | Codex shows |
| --- | --- | --- |
| Original (default) | 43% used | 75% left |
| % used everywhere | 43% used | 25% used |
| % left everywhere | 57% left | 75% left |
| Both | 43% used · 57% left | 25% used · 75% left |

The bars, widgets, tray tooltip, and notifications all follow the mode you pick. Warning colors always key off how much is used.

Mouse bindings, poll interval, launch-at-startup, and percent display live in the dashboard's Settings card.

## Troubleshooting

- **Claude: "Sign in with the CLI"**: run `claude` in a terminal and sign in, then hit refresh.
- **Claude: "renew sign-in"**: open Claude Code once (it refreshes the token automatically), then hit refresh.
- **Codex: "Sign in with the CLI"**: Pulse could not find or start `codex`. On Windows it checks the Codex desktop install, then PATH. Set `PULSE_CODEX_PATH` to the executable to point at a different install.
- **Codex shows a bar you don't have, or is missing one**: Pulse only shows windows the account service actually returns. A main 5h bar appears only when your account has that window.
- **A widget vanished**: check the dashboard's widget list; you can always delete and re-pin.

Your settings and widget layout are stored in `data/pulse.json` next to the app. Set `PULSE_DATA_DIR` to move it.

## Development

`npm test` checks Codex limit mapping (all five status windows), missing data, missing CLI, percent display modes, renderer syntax, and always-on-top recovery logic.

`test-pulse.js` and `test-codex-ui.js` drive a running instance over Chrome DevTools Protocol on port 9223. Launch that instance with `--remote-debugging-port=9223` and isolated `PULSE_DATA_DIR` and `PULSE_PROFILE_DIR` directories, because these tests create and delete widgets. A normal launch does not expose a debugging port.

Reference for the Codex rate-limit call: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt

The folder is still named ClaudePulse so existing paths keep working.
