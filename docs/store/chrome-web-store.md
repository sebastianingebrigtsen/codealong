# Chrome Web Store listing

Copy-paste material for the Chrome Web Store Developer Dashboard. Keep it in sync with the extension.

## Store listing

**Name:** CodeAlong

**Summary** (from `manifest.json`, max 132 characters):
Coding tutorials that wait for you. Pauses the video while you code in VS Code and continues when you're done.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Coding tutorials that wait for you.

You're following a coding tutorial. The instructor starts typing, so you pause the video, switch to your editor, type, switch back and press play – again and again. CodeAlong does the pausing for you.

• Start typing in VS Code → the tutorial pauses.
• Stop typing for a few seconds, or save → it rewinds 2 seconds and continues.
• Pause the video yourself → CodeAlong never starts it again on its own.
• Works with two screens. No more clicking back and forth.

HOW TO USE
1. Install this extension and "CodeAlong" for Visual Studio Code. Both are needed: this one controls the video, the VS Code one notices when you code.
2. Open a tutorial, click the CodeAlong icon and choose "Follow this tab".
3. Code along.

Works with YouTube, Laracasts and other sites with a standard HTML5 video player, including Vimeo embeds.

PRIVATE BY DESIGN
Everything happens on your computer. The two extensions talk over a local connection that websites can't use. CodeAlong never reads your code, records keystrokes or collects data. No account, no analytics.

Open source (MIT): https://github.com/sebastianingebrigtsen/codealong
```

## Graphics

| Asset                    | File                                             | Required |
| ------------------------ | ------------------------------------------------ | -------- |
| Store icon 128×128       | `packages/chrome/static/icons/128.png`           | yes      |
| Screenshot 1280×800      | `assets/store/chrome-screenshot-1280x800.png`    | yes (≥1) |
| Small promo tile 440×280 | `assets/store/chrome-promo-small-440x280.png`    | yes      |
| Marquee promo 1400×560   | `assets/store/chrome-promo-marquee-1400x560.png` | optional |

Regenerate with `npm run build && npm run assets`.

## Privacy practices

**Single purpose:**
Pause and resume the coding tutorial video in the tab the user chooses, based on whether the user is
currently typing in the CodeAlong VS Code extension.

### Permissions

| Permission                                 | Justification                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                  | Remembers whether CodeAlong is turned on and which tab the user chose to follow, so this survives browser and extension restarts.                                                        |
| `scripting`                                | Injects the video controller into the tab the user explicitly chooses to follow ("Follow this tab"), including tabs that were already open before installation.                          |
| `activeTab`                                | Lets the popup read the URL of the current tab when the user clicks the toolbar icon, so it can ask for access to just that site.                                                        |
| `alarms`                                   | Wakes the service worker every 30 seconds while a tutorial is followed, so the local connection to VS Code recovers after Chrome suspends the worker.                                    |
| Host: YouTube, Vimeo, Laracasts            | Finds and controls the video player on these common tutorial sites, including embedded YouTube/Vimeo players on other sites. The script stays inactive unless the user follows that tab. |
| Optional host: `https://*/*`, `http://*/*` | Requested for one site at a time, only when the user clicks "Follow this tab" on a site not listed above.                                                                                |

**Remote code:** No. All code is included in the package.

### Data usage

- Does the extension collect user data? **No.** (Tick none of the data categories.)
- The page title and host name of the followed tab are sent only to the CodeAlong VS Code extension
  on the same computer (127.0.0.1) and never leave the device.
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness.

**Privacy policy URL:** https://github.com/sebastianingebrigtsen/codealong/blob/main/docs/PRIVACY.md

## Notes for reviewers (Test instructions field)

```
CodeAlong needs its companion VS Code extension ("CodeAlong" by <publisher> on the Visual Studio Marketplace) running on the same computer; the two communicate over ws://127.0.0.1:47390.
To test: install the VS Code extension, open https://www.youtube.com/watch?v=rfscVS0vtbw, click the CodeAlong icon → "Follow this tab", play the video, then type in any file in VS Code. The video pauses; stop typing for 5 seconds and it rewinds 2 s and resumes.
Without VS Code the popup explains that VS Code was not found; no other functionality is affected.
```
