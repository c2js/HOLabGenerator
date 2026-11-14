# Workshop Capture

Narrate a task once, grab screenshots with the hotkeys you already use, and end
up with a portable HTML step-by-step guide.

The app captures and organises. An **in-app GitHub Copilot conversation** turns
the capture into a portable HTML tutorial using the project's bundled skill.

---

## Why it works this way

**Hotkeys drive an ordered event stream, so event order *is* step order.**
There is no timestamp reconciliation anywhere — you press a key, the thing that
just happened becomes the next step.

**Screenshots and annotation are 100% the operating system's job.**
`Ctrl+Alt+S` fires the real `Win+Shift+S` (or `screencapture -i` on macOS), so
you get the native region selector *and* the native annotation tools — pen,
highlighter, arrows, text, blur. The app only ingests the finished image. There
is no capture or annotation code in this repository.

**Speech-to-text is local.** `whisper.cpp` runs on your machine; audio never
leaves it. That matters when screenshots contain tenant names and subscription
IDs.

**Copilot is embedded, not launched in a terminal.** The JavaScript
`@github/copilot-sdk` runs in Electron's main process and streams the conversation
to the Generate tab. Follow-ups reuse the session; tool approvals and questions
appear inside the app. It uses existing GitHub authentication, not an API key
stored in your project.

**Local transcription and cloud generation are separate.** Whisper stays local.
Messages and file contents you let Copilot read are sent to its model provider.
Screenshots are represented in Markdown by `{{IMG:step-003}}` tokens; the skill
maps those to source images and copies them into the portable web output.

---

## The loop

```
Narrate + snip -> storyboard -> autosaved guide.md
                                      |
                                      v
                         in-app Copilot conversation
                                      |
                                      v
                         export/web/guide.html -> check
```

### Hotkeys

| Key | Action |
| --- | --- |
| `Ctrl+Alt+D` | Start / pause dictation |
| `Ctrl+Alt+S` | Pause dictation → native snip → annotate → ingest → resume |
| `Ctrl+Alt+Z` | Scratch that — drop the last step and its files |
| `Ctrl+Alt+B` | Section break |
| `Ctrl+Alt+C` | Capture the clipboard as a code block (the bar's **Paste** button) |
| `Ctrl+Alt+M` | Toggle compact mode |

A snip always finalises the current dictation segment first. That is what
guarantees the narration you just spoke is ordered *before* the screenshot.

### How snipping actually works

`Ctrl+Alt+S` does not capture anything itself. It fires the `ms-screenclip:`
protocol — byte-for-byte what Win+Shift+S does — and then watches two places for
the result:

1. **the clipboard**, using the Win32 clipboard *sequence number* so we can tell
   "changed" from "unchanged" without re-encoding a 4K image several times a second
2. **the screenshots folder**, for Win+PrtScn or Snipping Tool's *Save*

Whichever produces an image first wins.

**Annotation is captured, but not the way you might expect.** Windows puts the
*raw* selection on the clipboard the instant you finish dragging the region —
before you have had any chance to draw on it. Annotation happens afterwards, in
the Snipping Tool editor, and only reaches the outside world when you press
**Copy** or **Save**.

So the app takes the raw image immediately (the flow never stalls) and then keeps
watching for **60 seconds**. If a newer image appears in that window, it silently
replaces the one on the step, keeping its token, caption and position. In
practice: snip → annotate → `Ctrl+C`, and the step just updates. The control bar
says *"Annotate and copy or save to replace it"* while the window is open.

**Cancelling.** Pressing Escape is deliberately *not* detected. Windows keeps
several `SnippingTool` processes alive with non-zero window handles even when
nothing is on screen, so neither process presence nor window handles can tell
"the overlay is open" from "the user escaped". Rather than guess wrong, a pending
snip is simply abortable: **pressing `Ctrl+Alt+S` again always restarts it**. The
old wait is discarded, and the button reads *Retry* while one is pending.

The main window is large, and while you are demonstrating something that is
exactly what you cannot afford. A small always-on-top bar appears whenever a
project is open: recorder state, the last thing captured, and buttons for
Dictate, Snip, Section, Code, Undo and Open.

**Compact mode** (`Ctrl+Alt+M`, or the *Compact* button) hides the main window
entirely so only the bar remains. *Open* on the bar brings the window back. New
guides drop straight into it by default — there is a checkbox on the welcome
screen — so creating a guide puts you immediately into authoring.

During a snip the bar hides itself completely. It is always-on-top, so otherwise
it would sit in front of the very thing being captured.

A step can hold **several screenshots**. Each one has its own caption and can be
reordered, and every step shows an *Add a screenshot* slot that fires a snip
straight into that step — useful when one instruction needs to show both the menu
you open and the dialog it produces.

The bar is deliberately **non-focusable**: clicking Snip must not pull focus away
from the app you are demonstrating, because that would change what gets
captured. That also rules out `-webkit-app-region: drag`, which needs the window
to activate — so dragging is driven from pointer deltas with pointer capture,
which is what keeps it tracking once the cursor leaves the bar.

Its height is measured from its own content and reported to the main process, so
buttons are never clipped at a different DPI or font-scaling setting. Drag it
anywhere by the grip on its left; the position is remembered, and it is pulled
back on-screen if the monitor it was on disappears.

### Where guides are saved

Configurable on the welcome screen — *Guides are saved in …* with **Change…**
and **Open**. It defaults to `Documents\Workshop Guides`, and the choice is
stored in `settings.json` under the app's user-data folder.

### Storyboard shortcuts

| Key | Action |
| --- | --- |
| `J` / `K` | Move selection |
| `Alt`+`J` / `Alt`+`K` | Reorder the selected step |
| `Enter` | Edit the narration |
| `M` | Merge into the step above |
| `S` | Split at the cursor |
| `B` | Toggle section break |
| `Q` | Mark as quiz-worthy |
| `Delete` | Remove the step |

`S` is the fix for the most common capture mistake — talking through two steps in
one breath. Put the caret where they divide and press it.

---

## Getting started

```bash
npm install
npm run fetch:whisper   # downloads the model and the whisper.cpp engine
npm run dev
```

`fetch:whisper` gets both the model (`ggml-base.en.bin`, ~142 MB) and the CLI,
extracts it, and confirms the engine actually starts. The welcome screen shows
engine status, so you can tell at a glance whether transcription will work
before you narrate anything.

Transcription is optional at runtime. Without the engine, dictation still
records the audio and still creates the step — you just type the narration. That
audio is kept (successful ones are deleted), so installing the engine afterwards
recovers everything: the storyboard offers **Transcribe them now** for any step
that has audio but no narration, and each such step has its own
**Re-transcribe** button. **Losing transcription must never mean losing the
take.**

### Verify

```bash
npm run verify   # typecheck + unit tests + build + headless self-test
```

`npm run smoke` boots the real app and drives the real IPC surface end to end:
create a project in the configured folder → capture a step → write `guide.md` →
open the SDK conversation → scaffold and verify the web template → check the
control bar is visible, non-focusable, correctly sized and movable → toggle
compact mode → verify the generated guide → close cleanly. A GUI app that merely
starts without crashing proves very little; this proves the loop works.

The default self-test makes no model requests. Set `WC_SELFTEST_COPILOT=1` to also
start the real bundled SDK runtime and check authentication/model discovery.
`WC_SELFTEST_COPILOT_CHAT=1` additionally makes two small model requests using
synthetic text to check streaming and conversational recall. It requires working
Copilot authentication and may consume credits. Override the test model with
`WC_SELFTEST_COPILOT_MODEL` if needed.
With that live check enabled, `WC_SELFTEST_COPILOT_WRITE=1` also requests a tiny
file write in the disposable test lesson with automatic tool approval, to verify
the SDK's file tools rather than chat alone.

It runs against a throwaway user-data profile, so it can never overwrite your
real preferences, and it fails loudly if another instance already holds the
single-instance lock rather than exiting 0 having asserted nothing.

### Package it and run it like a normal app

```bash
npm run package:win
```

That produces **`release\Workshop Capture-0.1.0-setup.exe`** (it includes Electron,
the Whisper engine/model and the Copilot runtime). Run the installer and
the app appears in the Start Menu and on the desktop like anything else — no
terminal, no `npm run dev`.

It is a per-user install by default, so it needs no administrator rights, and you
can choose the install location. The build is **unsigned**, so SmartScreen will
warn on first run: *More info → Run anyway*.

`npm run package:dir` skips the installer and just produces
`release\win-unpacked\Workshop Capture.exe` if you would rather run it from a
folder or a USB stick.

---

## Project format

A `.guide` folder — readable, diffable, and nothing trapped inside it:

```
My Guide.guide/
  project.json          the app's working state (steps, metadata)
  .copilot-conversation.json
                        local chat transcript, model and resumable SDK session ID
  media/                screenshots, exactly as the OS annotator left them
  audio/                only appears if a recording could NOT be transcribed
  .agents/skills/learning-guide-md-to-html/SKILL.md
                        instructions for turning guide.md into the guide
  export/
    guide.md            the AI handoff - rewritten on every save
    layout.html         the markup and UI contract the skill builds against
    web/
      css/guide.css     presentation
      js/guide.js       behaviour
      fonts/            bundled typefaces
      media/            screenshots the finished guide references
      guide.html        the finished tutorial (written by your agent)
```

`project.json` is the source of truth; `guide.md` is generated from it. Edit
steps in the app, not in `guide.md`.

**The skill and its template travel with the project.** Every new guide is
scaffolded with `SKILL.md`, `layout.html` and the `web/` assets, so opening the
folder in a coding agent is enough — it already knows what to build and what to
build it from. Existing projects pick the template up next time they are opened,
and **nothing is ever overwritten**, so an author's own changes to the CSS or
layout survive.

`web/media/` starts empty on purpose: the skill copies in only the screenshots a
guide actually references.

**Nothing is lost to an accidental quit.** Saves are debounced, and `guide.md` is
rewritten alongside `project.json` every time — so the readable copy of what you
just recorded is always on disk. Quitting is held open until the flush finishes
rather than fired off and hoped for.

**Recordings are not kept.** The transcript is the artefact that matters, so a
dictation segment's WAV is deleted the moment its words are safely in the step.
Audio is retained *only* where transcription did not succeed, which is precisely
the case where deleting it would lose the take; those steps show a
**Re-transcribe** button, and the storyboard offers to transcribe them all at
once.

`audio/` is not created up front. It does appear briefly during every dictation —
the WAV has to be written before it can be transcribed — and is swept away again
once empty. Opening a project also sweeps any recording no step still refers to,
which is how a quit mid-transcription tidies itself up rather than stranding
audio forever.

**Dictation is capped at four minutes per take.** Whisper slows down on long
clips and a four-minute take is an unwieldy step anyway, so at the limit the
segment is closed, transcribed and a new one opened automatically. A short
double **beep** sounds a minute before, and a triple beep at the cut.

The alert is a tone rather than a spoken phrase for a specific reason: it plays
through the speakers while the microphone is still live, so whatever it is gets
recorded. Whisper transcribes a beep as a non-speech marker we already strip;
spoken words would end up as text in the very step being warned about.

### Choosing a microphone

The welcome screen has a **Microphone** picker, remembered in `settings.json`.
Device *names* only become readable after microphone permission has been granted
once, so the list fills in properly after your first dictation.

---

## The AI handoff

The **Generate** tab has two steps.

**1 · Build and revise with Copilot.** The Generate tab is a streaming chat,
powered by the GitHub Copilot JavaScript SDK (currently pinned to 1.0.34).
Send the prepared generation request, then ask for changes in the same
conversation. The model is editable, initially `gpt-5.6-terra`; **Check connection**
discovers the models your account can use.

Sign in to GitHub Copilot on the machine before using generation, with an active
Copilot entitlement. The SDK reuses existing authentication, including a supported
Copilot/`gh` login. No credentials are stored in the lesson or sent to the renderer.
The SDK package includes its matching platform runtime. It manages a background
runtime over JSON-RPC; the app no longer constructs commands, runs batch files,
or opens a command window. `COPILOT_CLI_PATH` can override the runtime if needed.

By default, approve or deny requested tool operations in the conversation.
**Allow tools automatically for this turn** is an explicit opt-in for trusted
projects; organisation-required manual approvals still appear. Automatic
approval permits shell execution and file changes. The project working directory
is **not** a filesystem security sandbox.

The session works from the **project root**, so the skill's relative paths and
source images resolve correctly. The latest capture is flushed to disk before
each message. **Stop** cancels the turn; closing/switching a project or quitting
stops its work and disconnects. Switching tabs does not interrupt it.

Chat history and the session ID are saved in `.copilot-conversation.json`.
Reopening the project restores the transcript and resumes the SDK session on the
next message. The SDK's underlying session storage remains local to the machine;
copying a lesson alone does not transfer that runtime history. A missing or
damaged SDK session reports an error instead of silently forgetting context.
**New conversation** archives the local transcript before starting afresh.

**2 · Check what it produced.** The app does not generate that file, so nothing
else verifies it. The check catches the failures that look fine on the machine
they were built on and break the moment the folder is copied elsewhere: a base64
image, an inline `<style>` or `<script>`, a CDN link, an absolute path, an
unreplaced `{{IMG:…}}` token, a referenced screenshot that is not in
`web/media/`, or a capture that never made it into the guide.

`guide.md` itself is designed to be unmisreadable by any model with no
surrounding context. Per step it carries the foreground app, the verbatim
narration, any clipboard command, and an image token:

```markdown
### Step 3
- **App:** Microsoft Edge - "Azure AI Foundry"
- **Narration:** "so now we go to the left hand side and click create agent"
- **Clipboard (bash):**

  ```bash
  az ai project create --name demo
  ```

- {{IMG:step-003}}
- **Suggest a knowledge check here.**
```

### What the check reports

- **missing** — the guide references a screenshot that is not in `web/media/`
- **unused** — a capture that never made it into the guide
- **unreferenced** — a file sitting in `web/media/` that nothing uses
- **not portable** — base64 images, inline `<style>`/`<script>`, CDN links,
  absolute paths, or unreplaced `{{IMG:…}}` tokens

### Can edited HTML become Markdown again?

**Content recovery is possible; a lossless round trip is not implemented.**
The generated guide has semantic headings, ordered task lists, code blocks,
figures/captions and `data-source-token` image markers. These provide useful
structure to recover. All `.page` sections must be read, including hidden ones;
extracting just the visible page loses most of the course.

Generation rewrites/merges raw narration and can add quizzes. HTML does not retain
all original step IDs, timestamps, app context, author intent or raw speech.
Markdown also cannot preserve the site's layout, navigation, progress, copy
controls, task persistence and interactive quiz behaviour. Quiz questions,
choices, answers and feedback need an explicit textual representation.

In Generate, expand **Edited the HTML and want Markdown?** and choose
**Draft a Markdown recovery request**, then send it. This is an AI-assisted
recovery request, not a deterministic converter or a storyboard importer.
It writes a separate `export/course.recovered.md` (or a new numbered filename)
and keeps screenshots linked as `web/media/...`. Review the recovered document
before using it as the editorial source for further Copilot revisions.

**Never save recovered edits into `export/guide.md`.** That file is generated
from `project.json` and autosave replaces it. To continue from recovered course
text, explicitly ask Copilot to use the recovered file as the source for the
next HTML revision and retain it alongside the raw capture. There is currently
no automatic merge of recovered content into the app's storyboard.

---

## The output

A portable folder, not a single file: `export/web/guide.html` alongside
`css/guide.css`, `js/guide.js`, `fonts/` and `media/`. Copy the `web/` folder
anywhere and it works offline, with no network requests.

The template is yours to change — the skill is explicitly told not to touch it —
and the app never overwrites it once scaffolded.

---

## Reviewing before you share

The **Review** tab shows every screenshot in the guide as one contact sheet, so
you scan for tenant names, subscription IDs and email addresses once,
deliberately, rather than hoping you remembered to blur each one at the time.

Anything that should not be published is fixed at the source: retake the
screenshot using the snip tool's own blur, or delete the step.

---

## Platform support

Windows first. macOS code paths are written behind a platform abstraction
(`src/main/platform/`) but are untested and unsigned in this version.

No native modules are used for OS integration: foreground window titles and the
clipboard change counter come from a single long-lived PowerShell process, which
keeps queries at a few milliseconds instead of the ~500ms a fresh `powershell.exe`
would cost.
