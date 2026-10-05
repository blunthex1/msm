# SignPath Foundation application: answers to paste

**Project name:** MSM for YouTube
**Repository:** https://github.com/blunthex1/msm
**License:** MIT
**Homepage / downloads:** https://github.com/blunthex1/msm/releases
**What is signed:** the Windows installers and portable executable (`MSM-for-YouTube-Setup-*.exe`, `MSM-for-YouTube-Portable-*.exe`), built by GitHub Actions (`.github/workflows/build.yml`).

**Description:** A desktop YouTube app for Windows (Electron) with a built-in filter for AI-generated videos, ad and tracker blocking (Ghostery's open-source engine with uBlock Origin / EasyList lists), SponsorBlock sponsor skipping, and a Shorts blocker. The same filter is also published as a browser extension. All code is MIT-licensed; dependencies are open source (Electron, electron-updater, @ghostery/adblocker-electron).

**Why signing is needed:** Windows Smart App Control and SmartScreen block unsigned installers, so users cannot install or update the app.

**Team:** blunthex1 is the sole committer, reviewer and approver.

**Privacy:** see the Privacy section of the README. No telemetry.

## Policy section to add to the README after approval

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers, reviewers and approvers: [blunthex1](https://github.com/blunthex1)
- Privacy: see [Privacy](#privacy).
