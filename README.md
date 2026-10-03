# MSM — YouTube without the AI slop

Two things in one repo, sharing one filter engine:

1. **MSM for YouTube**: a dedicated desktop YouTube app for Windows (also builds for macOS and Linux). It's a focused YouTube window with its own menu, mouse back/forward buttons, saved sign-in and window position, and the AI filter built in.
2. **AI Filter for YouTube**: a browser extension for Chrome, Edge and Firefox that hides AI-generated videos on youtube.com.

## What the filter does

- **Hides or blurs AI-generated videos** in search, home, sidebar recommendations, channel pages, Shorts shelves and end screens. In blur mode each hidden video says *why* it was hidden, with **Show** and **Allow channel** buttons.
- **Keyword packs**:
  - *AI-generated videos* (on by default): "AI generated", "made with AI", Sora 2, Veo 3, Kling, Midjourney, Suno, `#aiart`, "AI cat", and about 80 more.
  - *AI news, hype & tutorials* (off by default): ChatGPT, LLMs, "AI", GPT and similar. Turn it on to hide AI as a topic.
- Matching is whole-word (`ai` won't match "said" or "Thailand") and handles `AI-art`, `#aiart`, plurals and fancy Unicode text like `𝐀𝐈 𝐀𝐫𝐭`. You can add your own keywords or `/regex/` patterns, and switch off any built-in keyword.
- **Channel block list and allow list.** The allow list always wins.
- **YouTube's "Altered or synthetic content" label.** On a watch page the filter notices the label and offers to block the channel. It can also do this automatically.
- **Hides YouTube Playables** (on by default): the games shelf on the home feed, single game cards, and the Playables link in the sidebar. Turn it off in settings.
- **Sponsor skipping** (on by default): jumps over sponsor and self-promotion segments inside videos, using the community [SponsorBlock](https://sponsor.ajay.app) database. A small "Skipped sponsor · Undo" notice appears. Only a 4-character hash prefix of the video ID is sent, so the server can't tell which video you're watching.
- **Shorts blocker** (on by default): hides Shorts shelves, single Shorts cards and the Shorts sidebar link. Any `/shorts/…` link opens in the normal video player instead. Turn it off in settings, or in the app under **AI Filter → Block Shorts**.
- **A small "AI Filter" bar** on watch and channel pages for one-click block or unblock.
- Settings live only on your machine: no account, no analytics, no network requests. The extension only asks for the `storage` permission.

## Desktop app (Windows)

### Install
Download `MSM-for-YouTube-Setup-<version>-x64.exe` (or the portable `.exe`) from the GitHub **Releases** page, or from the `windows-app` artifact of the latest **Build** workflow run.

The app isn't code-signed yet, so Windows SmartScreen will warn on first launch: choose **More info → Run anyway**.

### Using it
| Shortcut | Action |
| --- | --- |
| `Alt+←` / `Alt+→`, mouse back/forward buttons | Back / forward |
| `Alt+Home` | YouTube home |
| `Ctrl+R` / `F5` | Reload |
| `Ctrl+Shift+V` | Open a YouTube link from the clipboard |
| `Ctrl+Shift+C` | Copy the current page link |
| `Ctrl+Shift+F` | Turn the AI filter on/off |
| `Ctrl+Shift+B` | Block the channel you're watching |
| `Ctrl+,` | AI filter settings |
| `Ctrl+Shift+T` | Always on top |
| `F11` | Full screen |
| `Ctrl+N` | New window |

- Links to other sites open in your normal browser. YouTube and Google sign-in stay in the app.
- You can launch it with a URL (`MSM.exe https://youtu.be/...`) to open that video.
- Settings are stored in `%APPDATA%\MSM for YouTube\config.json`.

**Signing in:** Google sometimes blocks sign-in from "embedded" browsers. The app shows Google's sign-in pages a standard Firefox user-agent, the usual workaround. If Google still refuses, please open an issue.

### Shields (ad & tracker blocking)
The app blocks ads and trackers the way Brave Shields does. It uses [Ghostery's open-source blocking engine](https://github.com/ghostery/adblocker) with the uBlock Origin, EasyList and EasyPrivacy filter lists. Requests to ad and tracking servers are blocked at the network level, and ad elements are hidden on the page. It's on by default. Toggle it with **Shields → Block Ads & Trackers** (`Ctrl+Shift+S`). The filter lists are downloaded on first launch and cached in the app's data folder.

## Browser extension

### Chrome / Edge
1. `npm install && npm run build`
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `dist/chrome` folder.

### Firefox (121+)
Run `npm run build`, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`.

Click the toolbar icon for quick on/off, hide/blur mode, the number of videos filtered on the page, and block/allow for the channel you're on.

## Development

```bash
npm install
npm test            # unit tests (rules) + engine tests against YouTube-shaped markup (jsdom)
npm run build       # extension -> dist/chrome, dist/firefox ; app bundles -> app/dist
npm start           # build + launch the desktop app
npm run dist:win    # Windows installer + portable exe -> release/  (run on Windows, or Linux with Wine)
```

```
core/            shared filter: rules.js (matching), defaults.js (keyword packs),
                 youtube.js (DOM selectors), engine.js (scan/hide/blur/page bar),
                 filter.css, options/ (settings page used by both targets)
extension/       Manifest V3 extension: content script, popup, manifest
app/             Electron app: main.js, sandboxed preloads, settings window
scripts/         build.mjs (esbuild), make-icons.mjs
test/            node:test suites
```

How it fits together: the engine runs as a content script in the extension and inside the app's sandboxed, context-isolated preload. Each target supplies a tiny storage adapter: `chrome.storage.local` for the extension, IPC to a JSON file for the app. Nothing is exposed to YouTube's own page scripts.

YouTube changes its markup often. All selectors live in `core/youtube.js`. If videos stop being filtered, look there first.

### CI
`.github/workflows/build.yml` runs the tests, uploads the built extensions, and builds the Windows installer on `windows-latest`. Push a tag like `v0.1.0` to publish a GitHub Release with the installer and extension zips attached.

## Limits
- Keyword and channel based: a video with an innocent title from a channel you haven't blocked will get through. Block the channel once (watch-page bar, `Ctrl+Shift+B`, or the popup) and its videos stay hidden everywhere.
- The synthetic-content label is only visible on the watch page, so it can't be used to filter feeds directly. Turn on auto-block to make it feed your block list.
- This is an unofficial project, not affiliated with or endorsed by YouTube or Google.
