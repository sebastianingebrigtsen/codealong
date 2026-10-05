<p align="center">
  <img src="packages/vscode/images/icon.png" width="96" height="96" alt="">
</p>

<h1 align="center">CodeAlong</h1>

<p align="center"><strong>Coding tutorials that wait for you.</strong></p>

<p align="center">
  <a href="https://github.com/sebastianingebrigtsen/codealong/actions/workflows/ci.yml"><img src="https://github.com/sebastianingebrigtsen/codealong/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

You're following a coding tutorial. The instructor starts typing, so you pause the video, switch to
your editor, type, switch back, press play… and repeat that a hundred times.

**CodeAlong does the pausing for you.** Start typing in VS Code and the tutorial in Chrome pauses.
Stop typing, and it rewinds two seconds and continues. You keep your eyes on the code and your hands
on the keyboard.

![CodeAlong pauses the tutorial while you code](assets/store/chrome-screenshot-1280x800.png)

## Features

- **Pauses when you start typing** in VS Code, once per burst of typing.
- **Continues when you're done**: after a few seconds without typing, when you save, or when you say so.
- **Rewinds a little** before continuing, so you don't miss the end of a sentence.
- **Never overrides you.** If you pause the video yourself, CodeAlong will not start it again.
- **Works across two screens**: no clicking back and forth between windows.
- **Private by design**: everything stays on your computer. No account, no cloud, no analytics.
  Your code is never read or sent anywhere.

## Installation

CodeAlong has two small parts that work together: one for Chrome (controls the video) and one for
VS Code (notices that you are coding). Install both:

|             |                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| **Chrome**  | Chrome Web Store: _coming soon_ <!-- TODO(release): link the Chrome Web Store listing -->             |
| **VS Code** | Visual Studio Marketplace: _coming soon_ <!-- TODO(release): link the VS Code Marketplace listing --> |

Until the store listings are live, you can [build and load both from source](#building-from-source).

## Getting started

1. Open a coding tutorial in Chrome.
2. Click the **CodeAlong** icon in the toolbar (pin it via the puzzle-piece menu) and choose
   **Follow this tab**.
3. Start the video and code along in VS Code.

The toolbar icon shows **ON** when Chrome and VS Code are connected. The VS Code status bar shows
what CodeAlong is doing: **CodeAlong: Tutorial Playing**, **CodeAlong: Coding... (resume in 3s)** and so on.
Both parts find each other automatically. There is nothing to configure.

### When does it pause and continue?

| When you…                                             | CodeAlong…                                     |
| ----------------------------------------------------- | ---------------------------------------------- |
| start typing in VS Code while the tutorial plays      | pauses it                                      |
| stop typing for 5 seconds                             | rewinds 2 seconds and continues                |
| save the file (Ctrl+S / Cmd+S)                        | continues about a second later                 |
| pause the video yourself                              | **never** starts it again on its own           |
| press play while you're still typing                  | lets it play until you stop                    |
| scrub through the video while CodeAlong has it paused | waits, and doesn't rewind your chosen position |

### Keyboard shortcuts

| Action                     | VS Code                    | Chrome        |
| -------------------------- | -------------------------- | ------------- |
| Pause or play the tutorial | `Ctrl+Alt+P` (macOS `⌃⌥P`) | `Alt+Shift+P` |
| I'm done, continue now     | `Ctrl+Alt+D` (macOS `⌃⌥D`) | `Alt+Shift+D` |

Change them in VS Code under _Keyboard Shortcuts_ and in Chrome at `chrome://extensions/shortcuts`.
To turn CodeAlong off for a while, click **CodeAlong** in the VS Code status bar, or use the switch
in the Chrome popup.

### Settings

All settings live in VS Code (_Settings_ → search for "CodeAlong"):

| Setting                           | Default | Description                                                                             |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `codealong.enabled`               | `true`  | Turn automatic pausing and resuming on or off.                                          |
| `codealong.pauseOnTyping`         | `true`  | Pause when you start editing code.                                                      |
| `codealong.resumeAfterIdle`       | `true`  | Continue when you've stopped typing.                                                    |
| `codealong.idleDelaySeconds`      | `5`     | Seconds without typing that count as "done".                                            |
| `codealong.resumeOnSave`          | `true`  | Saving a file counts as "done" (auto save is ignored).                                  |
| `codealong.resumeOnTutorialFocus` | `false` | Continue when you switch back to the tutorial tab. Handy on one screen.                 |
| `codealong.rewindBeforeResume`    | `true`  | Rewind before continuing automatically.                                                 |
| `codealong.rewindSeconds`         | `2`     | How far to rewind.                                                                      |
| `codealong.debugLogging`          | `false` | Log events to the _CodeAlong_ output channel for troubleshooting. Code is never logged. |

## Supported platforms

|                       |                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Browser**           | Google Chrome 116+                                                                                                                                                       |
| **Editor**            | Visual Studio Code 1.95 or newer. Automatically tested on 1.95.3 (the minimum) and 1.140.0, plus a weekly check against the latest stable release.                       |
| **Video sites**       | YouTube and Laracasts (verified). Any site with a standard HTML5 video player, including players in iframes (e.g. Vimeo embeds) and web components with open shadow DOM. |
| **Operating systems** | macOS: verified by hand and in automated tests. Windows and Linux: unit and integration tests run in CI; not yet verified by hand.                                       |

Other Chromium browsers (Edge, Brave, Arc) and VS Code forks (Cursor, VSCodium) may work but are not
tested. Firefox, Safari and other editors are not supported.

## Privacy

CodeAlong runs entirely on your computer. The VS Code extension tells the Chrome extension only
_that_ you typed or saved, never _what_. It doesn't read, store or transmit your code, it doesn't
record keystrokes, and it has no analytics or remote servers. The two extensions talk over a local
connection (`127.0.0.1`) that websites cannot use.

Details: [Privacy policy](docs/PRIVACY.md) · [Security](SECURITY.md)

## Known limitations

- Videos must use a standard HTML5 `<video>` element. Players that draw into a canvas or hide the
  video in a _closed_ shadow root are not detected.
- On sites other than YouTube, Vimeo and Laracasts, Chrome asks for permission once per site. A
  video in a cross-origin iframe on such a site (other than a YouTube or Vimeo embed) is not detected.
- "Done" is a heuristic. If you pause to think for longer than the idle delay, the video continues.
  Raise `codealong.idleDelaySeconds`, or turn off `codealong.resumeAfterIdle` and continue by saving
  or with the shortcut.
- Typing in any file counts; CodeAlong doesn't know which files belong to the tutorial.
- The Chrome shortcuts only work while Chrome has focus. Use the VS Code shortcuts while coding.
- While the integrated terminal has focus, VS Code passes the shortcuts to the shell instead.

## How it works

```
Chrome extension             local connection (127.0.0.1)            VS Code extension
finds & controls the video   ◄────── typing / save signals ───────   notices that you code,
knows who paused it          ─────── video state ────────────────►   decides when to pause/play
```

The VS Code extension holds a small state machine that decides _when_ to pause and play. The Chrome
extension knows _who_ paused the video and refuses to resume anything the user paused. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the details and the invariants.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Building from source

Requires Node.js 22+, Chrome and VS Code.

```bash
git clone https://github.com/sebastianingebrigtsen/codealong.git
cd codealong
npm install
npm run dev        # builds both extensions and rebuilds on change
```

- **Chrome:** open `chrome://extensions`, enable _Developer mode_, click _Load unpacked_ and select
  `packages/chrome/dist`.
- **VS Code:** open the repository in VS Code and press F5 (_Run CodeAlong_). Or build an installable
  package with `npm run package -- --allow-dev-id` and choose _Extensions → … → Install from VSIX_ →
  `dist/codealong-vscode-<version>.vsix`.

## Roadmap

CodeAlong is in early development (0.x). Under consideration, not promised:

- Listings in the Chrome Web Store and the VS Code Marketplace
- Verified support for more video sites and Chromium-based browsers
- Only counting typing inside the tutorial's project folder

Have an idea? [Open a feature request](https://github.com/sebastianingebrigtsen/codealong/issues/new/choose).

## License

[MIT](LICENSE) © Sebastian Westin Ingebrigtsen
