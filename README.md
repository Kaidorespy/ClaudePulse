# ClaudePulse

Desktop widgets for your Claude usage limits. Pin any limit (session, weekly) as a slim floating bar that sits on your desktop, updates itself, and warns you before you hit the wall.

- Live usage bars for every limit on your plan, pulled from the same endpoint claude.ai uses
- Pin any bar as a frameless always-on-top desktop widget — drag it anywhere, resize it, keep as many as you want
- Desktop notifications when a limit crosses 75%, 90%, and 100%
- Tray icon with at-a-glance percentages in the tooltip
- No accounts, no configuration files to write, no data leaves your machine except the usage request to `api.anthropic.com`

## Requirements

- Windows, macOS, or Linux (prebuilt downloads on [itch.io](https://formslip.itch.io/claude-pulse))
- [Node.js](https://nodejs.org) 18+ (only if running from source)
- [Claude Code](https://claude.com/claude-code) signed in at least once — ClaudePulse reads the local OAuth token Claude Code already saved (`~/.claude/.credentials.json`, or the Keychain on macOS, read-only) and uses it to ask Anthropic for your usage numbers. Nothing else is done with it.

macOS note: the app is unsigned. If macOS blocks it, right-click → Open, or allow it under System Settings → Privacy & Security. Downloads through the [itch app](https://itch.io/app) avoid this entirely.

## Quick start

```
npm install
npm start
```

The dashboard opens; closing it minimizes to the tray. Quit from the tray icon.

## Using it

- **Pin a widget** — hit "pin as widget" under any usage bar in the dashboard.
- **Move / resize** — drag a widget with the drag button (default: right mouse). Drag near the right edge to resize.
- **Always-on-top** — double-click a widget with the drag button to toggle, or use the checkbox in the dashboard's widget list.
- **Remove** — click a widget with the delete button (default: middle mouse), or the ✕ in the dashboard list.
- **Hover** a widget to see time until reset.

Mouse bindings, poll interval, and launch-at-startup live in the dashboard's Settings card.

## Troubleshooting

- **"Couldn't find Claude Code credentials"** — run `claude` in a terminal and sign in, then hit refresh.
- **"Token expired"** — open Claude Code once (it refreshes the token automatically), then hit refresh.
- **A widget vanished** — widgets that end up on a disconnected monitor are pulled back to your main screen automatically within a second or two. If you don't see one, check the dashboard's widget list; you can also just delete and re-pin.

Your settings and widget layout are stored in `%APPDATA%\claude-pulse\pulse.json`.

## Development

`test-pulse.js` is a smoke test that drives the real UI over the Chrome DevTools protocol. Start the app with `npx electron . --remote-debugging-port=9223`, then run `node test-pulse.js` in a second terminal.
