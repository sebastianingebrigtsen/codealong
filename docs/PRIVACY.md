# CodeAlong Privacy Policy

_Last updated: 2026-10-05_

CodeAlong consists of a Chrome extension and a VS Code extension. This policy covers both.

## Summary

CodeAlong does not collect, store, sell or share any personal data. Everything it does happens on
your own computer. There is no CodeAlong server, account, analytics or tracking.

## What CodeAlong processes, and where

| Data                                                       | Why                                                    | Where it goes                                               |
| ---------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| The fact that you edited or saved a file in VS Code        | To know when to pause and continue the tutorial        | From VS Code to the Chrome extension, on your computer only |
| State of the tutorial video (playing/paused, current time) | To pause, resume and rewind it                         | Between the two extensions, on your computer only           |
| Title and host name of the tab you follow                  | To show which tutorial is active in VS Code and Chrome | Between the two extensions, on your computer only           |
| Your settings and the followed tab                         | To remember your choices                               | Stored locally by Chrome and VS Code                        |

CodeAlong **never** reads the contents of your files, never records keystrokes, never reads web
pages beyond the video element and title of the tab you choose to follow, and never sends anything
over the internet.

The two extensions communicate over a local connection (`127.0.0.1`) that only the CodeAlong Chrome
extension and other CodeAlong VS Code windows can use. A random key file
(`~/.codealong/editor-token`) lets your VS Code windows recognise each other. It contains no
personal data.

## Permissions

The Chrome extension asks for access to YouTube, Vimeo and Laracasts so it can find and control
their video players. It asks for other sites only when you click **Follow this tab** there, and
only for that site. See the [permission justifications](store/chrome-web-store.md#permissions) for
details.

## Third parties

None. CodeAlong includes no third-party services, SDKs or remote code.

## Contact

Questions: [open an issue](https://github.com/sebastianingebrigtsen/codealong/issues).
Security concerns: see [SECURITY.md](../SECURITY.md).

Changes to this policy are published in this file and noted in the [changelog](../CHANGELOG.md).
