# Claude Apps

Apps I design, build and ship with Claude as my AI coding partner. I decide what each app
should do, direct the work, test it and release it. Every app here has its own README with
setup steps.

| App | What it is | Get it |
| --- | --- | --- |
| [**Snug**](https://github.com/DominicsUSE/Claude-apps/tree/snug-v0.15.0/snug) | A calm chat app for your people: communities, rooms, threads, direct messages, voice and video calls, screen sharing, roles and themes. Real accounts, a real database and live delivery. Desktop app for Windows and Mac. | [Releases](https://github.com/DominicsUSE/Claude-apps/releases?q=snug) |
| [**Siteless**](siteless) | A Windows app that maps well-reviewed local businesses with no website or a bad one, and writes a ready-made offer to build them one. | [Releases](https://github.com/DominicsUSE/Claude-apps/releases?q=siteless) |
| [**Build Atlas**](realestate-globe) | An interactive 3D globe that scores cities and countries for starting a real-estate development company, by price, growth potential and property safety. | [Open the README](realestate-globe) |
| [**Money, Charted**](money-charted) | A pipeline that turns official money data into finished YouTube Shorts: narration, animated chart, captions and thumbnail. | [Open the README](money-charted) |
| [**Pulse**](pulse) | A messenger app design: a single-page web app with the full chat interface. | [Open it](pulse) |

## How these are built

- **Tested before release.** Snug runs unit tests, server tests with real sockets and
  end-to-end tests with several people in separate browsers. Calls, screen sharing, messages,
  moderation and settings are all covered.
- **Built and released by CI.** GitHub Actions builds the Windows and Mac apps on every change
  and publishes tagged releases (`snug-v*`, `siteless-v*`).
- **Security checked.** Snug's pipeline runs gitleaks, CodeQL, Semgrep, OSV-Scanner,
  `npm audit` and Electronegativity. See [`snug/SECURITY.md`](https://github.com/DominicsUSE/Claude-apps/blob/snug-v0.15.0/snug/SECURITY.md).

## Contact

Dominic, Vilnius, Lithuania. [dominic.rimsa@gmail.com](mailto:dominic.rimsa@gmail.com)
