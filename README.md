# Hands On Lab Generator

Turn voice narration and screenshots into step-by-step HTML lab guides.
Capture your workflow, review the steps, and build the tutorial through an
**in-app GitHub Copilot conversation**.

**Windows-first.** macOS capture paths are implemented but not yet tested.

## See it in action

![Animated interface tour: setup, Storyboard, Review, Generate, compact controls and the finished HTML guide](https://github.com/user-attachments/assets/a6ab8789-695f-400d-a605-4b0ecd3d91d5)

A 27-second tour of real app screens and a finished HTML guide, not a live AI-generation recording.

<details>
<summary>View individual screenshots</summary>

**Storyboard:** edit narration, organise sections, add screenshots and mark quiz opportunities.

![Storyboard with narration, a screenshot and a quiz hint](https://github.com/user-attachments/assets/2ef26715-c3b5-489d-8404-e1987842d0e6)

**Generate:** build and revise the HTML guide with Copilot and explicit tool approvals.

![In-app Copilot conversation and generation request](https://github.com/user-attachments/assets/23539882-af6d-4b93-ba14-02271b013dbb)

**Compact mode:** a draggable bar that stays out of the way.

![Floating capture bar with Dictate, Snip, Section, Paste, Undo, Open and Exit](https://github.com/user-attachments/assets/af6c799b-5d8a-4914-8eb8-742922ff5db3)

</details>

## Get started

Requires Node.js/npm. Sign in to GitHub Copilot on the machine with an active
Copilot entitlement before using generation.

```powershell
npm install
npm run fetch:whisper
npm run dev
```

1. **Create a guide.** Choose the save folder and microphone.
2. **Narrate and snip.** Capture instructions and native screenshots in order.
3. **Review.** Edit the storyboard, add images and flag useful knowledge checks.
4. **Generate.** Send the prepared Copilot request, ask for revisions, then check
   and open `export\web\guide.html`. Share the entire `export\web` folder.

## Capture shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+D` | Start/pause dictation |
| `Ctrl+Alt+S` | Snip; press again to restart a cancelled snip |
| `Ctrl+Alt+B` | Start a section |
| `Ctrl+Alt+C` | Capture clipboard text as code |
| `Ctrl+Alt+Z` | Undo the last step |
| `Ctrl+Alt+M` | Toggle compact mode |

After snipping, annotate in the OS tool and **Copy or Save within 60 seconds**
to replace the raw capture. The bar hides during snips. Dictation splits at
four minutes, with a warning beep one minute before.

Closing a lesson window switches to compact mode; **Open** restores it.
**Exit** asks for confirmation and saves before quitting. Launching the app
again restores an existing hidden window.

## Files and privacy

Each `.guide` folder contains `project.json`, screenshots, autosaved
`export\guide.md`, and the bundled HTML-generation skill and web template.
Edit captured steps in the app: **autosave overwrites `guide.md`**.

Whisper transcription stays local. Successful recordings are deleted; failed
takes remain available for re-transcription. Copilot sends messages and approved
file content to its model provider. Automatic tool approval is opt-in and is
**not a filesystem sandbox**. Review screenshots for sensitive content before sharing.

Edited HTML can be recovered to a separate `export\course.recovered.md` from
Generate. Recovery is AI-assisted, not lossless, and does not import storyboard steps.

## Build a desktop app

```powershell
npm run verify        # typecheck, tests, build and real-app smoke checks
npm run package:win   # Windows installer, no development terminal needed
npm run package:dir   # unpacked application
```

Installer: `release\Hands On Lab Generator-0.1.0-setup.exe`.
The Windows build is unsigned, so SmartScreen may warn on first run.
