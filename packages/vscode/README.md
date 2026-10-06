# CodeAlong for VS Code

**Coding tutorials that wait for you.**

Start typing in VS Code and the coding tutorial you're watching in Chrome pauses. Stop typing, and it
rewinds two seconds and continues. No more pausing, switching windows and pressing play a hundred times.

![CodeAlong pauses the tutorial while you code](https://raw.githubusercontent.com/sebastianingebrigtsen/codealong/main/assets/store/chrome-screenshot-1280x800.png)

> **CodeAlong has two parts.** This extension notices _that_ you are coding. The
> **[CodeAlong Chrome extension](https://chromewebstore.google.com/detail/codealong/jhfmljdjpeaclncddhhifegcknjgfjij)**
> pauses and plays the video. Install both; they find each other automatically.

## Getting started

1. Install this extension and [CodeAlong for Chrome](https://chromewebstore.google.com/detail/codealong/jhfmljdjpeaclncddhhifegcknjgfjij).
2. In Chrome, open a tutorial, click the **CodeAlong** toolbar icon and choose **Follow this tab**.
3. Code along. The status bar, and a small label on the video, show what CodeAlong is doing.

The **Get Started with CodeAlong** walkthrough (_Help → Welcome_) covers the same in four short steps.

## When does it pause and continue?

| When you…                             | CodeAlong…                           |
| ------------------------------------- | ------------------------------------ |
| start typing while the tutorial plays | pauses it                            |
| stop typing for 5 seconds             | rewinds 2 seconds and continues      |
| save the file                         | continues about a second later       |
| pause the video yourself              | **never** starts it again on its own |
| press play while you're still typing  | lets it play                         |

## Settings

Timing and behaviour are set in Chrome: click the CodeAlong icon, then **Settings**. You can change
how long CodeAlong waits after you stop typing, whether saving continues the video, how far it
rewinds, and more. Changes apply here instantly.

![CodeAlong settings](https://raw.githubusercontent.com/sebastianingebrigtsen/codealong/main/assets/store/chrome-screenshot-settings-1280x800.png)

In VS Code, click **CodeAlong** in the status bar to turn automatic pausing on or off. The only VS Code
setting is `codealong.debugLogging`, which writes events to the _CodeAlong_ output channel when
troubleshooting. Your code is never logged.

> Upgrading from 0.1.0? The timing settings that used to live in VS Code have moved to the Chrome
> popup. The old VS Code settings are no longer used.

## Commands and shortcuts

| Command                                  | Shortcut                   |
| ---------------------------------------- | -------------------------- |
| CodeAlong: Pause or Play Tutorial        | `Ctrl+Alt+P` (macOS `⌃⌥P`) |
| CodeAlong: I'm Done – Continue Tutorial  | `Ctrl+Alt+D` (macOS `⌃⌥D`) |
| CodeAlong: Turn Automatic Pausing On/Off |                            |
| CodeAlong: Timing and Settings           |                            |
| CodeAlong: How CodeAlong Works           |                            |
| CodeAlong: Get the Chrome Extension      |                            |

Click **CodeAlong** in the status bar for a menu with these.

## Privacy

Everything stays on your computer. CodeAlong never reads, stores or sends your code and doesn't
record keystrokes. It only notices _that_ a file changed or was saved, and passes that signal to
the Chrome extension over a local connection that websites can't use. No account, no analytics.
[Privacy policy](https://sebastianingebrigtsen.github.io/codealong/PRIVACY.html).

The extension runs on your local machine even in Remote / WSL / Dev Container windows, because that
is where Chrome is.

## Feedback

[Report a bug or request a feature](https://github.com/sebastianingebrigtsen/codealong/issues) ·
[Source code](https://github.com/sebastianingebrigtsen/codealong) · MIT license
