---
name: learning-guide-md-to-html
description: "Generates or regenerates export/web/guide.html from workshop-capture export/guide.md and referenced screenshots, using export/layout.html and the canonical split web assets. Use for guide export, narration captures, image tokens, author notes, or rebuilding the portable web tutorial."
compatibility: "Designed for coding agents with file editing and browser automation."
metadata:
  version: "2.0.0"
---

# Generate the Guided Tutorial

Transform `export/guide.md` into `export/web/guide.html`. Use `export/layout.html` as the required semantic markup and UI contract. The canonical presentation and runtime are already provided by:

- `export/web/css/guide.css`
- `export/web/js/guide.js`
- `export/web/fonts/`

Do not redesign or overwrite the layout, CSS, JavaScript, or fonts unless the user explicitly asks to change the template. Do not modify `export/guide.md`, `project.json`, or the root `media/` sources.

## Inputs and Outputs

- Read the capture from `export/guide.md`.
- Use `project.json` to map each `{{IMG:step-NNN}}` token to its source filename in `media/`.
- Read `export/layout.html` before generating markup.
- Write the finished tutorial to `export/web/guide.html`.
- Copy only source-referenced screenshots into `export/web/media/`, preserving filenames.
- In the generated guide, reference `css/guide.css`, `js/guide.js`, and `media/<filename>` with paths relative to `export/web/guide.html`.

## Interpret the Capture

- Preserve the demonstrated workflow and action order, not the raw narration.
- Rewrite speech-to-text into concise, imperative, single-action steps. Remove filler, repetition, false starts, empty captures, and commentary that does not help the learner complete the task.
- Treat clipboard content as exact text. Use visible UI evidence to resolve unclear narration; ask the user only when ambiguity would materially change an action, value, or outcome.
- Do not invent prerequisites, actions, features, results, or screenshots. Clearly label variable generated output as an example.
- Keep all useful author notes and honor explicit knowledge-check requests.

## Follow the Layout Contract

- Preserve the header, brand structure, live page count, theme toggle, semantic page structure, and fixed footer hooks shown in `export/layout.html`.
- Give the guide a stable, unique `data-guide-id` so theme and task persistence do not collide with other guides.
- Keep `data-guide-page-count`, `data-theme-toggle`, `data-guide-previous`, `data-guide-next`, `data-guide-progress-label`, `data-guide-progress`, `data-guide-footer`, and `data-guide-completion-status` hooks intact.
- Keep the first `.page` visible. Add `hidden` and `aria-hidden="true"` to every later page. Give every page a unique heading ID and matching `aria-labelledby`.
- Set initial top-bar and footer counts to the actual number of `.page` sections. JavaScript maintains them after load.
- Do not add inline CSS, inline executable JavaScript, frameworks, remote fonts, analytics, or network dependencies.

## Author the Tutorial

- Start with a compact overview: literal task title, one-sentence objective, prerequisites, and a short session outline.
- Group related actions into focused sessions/pages. Each page should teach one meaningful outcome. Use an ordered native-checkbox task list only on pages where the learner performs demonstrated actions.
- Make each task-list item one concise learner action. Keep the action text, its checkbox, exact input or copy control, essential note, and supporting screenshot together inside the same ordered-list item. Author this hierarchy directly in the semantic HTML rather than moving content into task items with JavaScript. Place supporting content after the action text so the page reads as one continuous instructional flow; do not put screenshots in a detached gallery, parallel media column, or separate list.
- Include only actions the learner actually performs. Do not create checklist items for reading the overview, reviewing the session outline, selecting tutorial navigation, reading an explanatory note, or acknowledging completion. Overview and completion pages should not contain synthetic task lists unless the source demonstrates a real action on those pages.
- Show exact commands, prompts, paths, and values in monospace blocks. Add a compact icon-only copy control beside every block the learner must type. Copy the complete text without formatting or modification; use native button semantics, an accessible name and tooltip, keyboard focus, a brief checkmark/live success message, and a direct-file clipboard fallback. Do not use a large text-labeled Copy button.
- Use brief notes only for essential context, warnings, or optional features.
- Place each relevant screenshot directly beneath the action it supports, inside that action's list item, exactly once, with useful alt text and a short caption. Use `media/<filename>` and retain `data-source-token="step-NNN"` on its figure.
- Finish with a concise completion state that states what the learner accomplished.

## Knowledge Checks

- Add an occasional knowledge check after a meaningful session, not after every page. Prefer one check every two or three sessions or wherever the source explicitly requests one.
- Ask one or two questions that test the session objective, decision, or sequence. Do not test trivia or information not taught in the guide.
- Use accessible radio buttons or checkboxes, a **Check answer** action, and brief corrective feedback. Do not reveal the answer before submission; allow retrying and do not block tutorial navigation.

## Preserve Accessibility and Runtime Behavior

- Use semantic headings, ordered lists, labels, fieldsets, legends, native form controls, useful alt text, and live regions shown by the layout.
- Keep one page visible at a time and preserve heading focus behavior, Previous/Next/Finish behavior, progress updates, task persistence, copy fallback, quiz feedback, theme behavior, and dynamic footer spacing by keeping the layout hooks intact.
- Use unique `data-task` values within the guide.
- Keep screenshots responsive by using the figure structure from the template and existing stylesheet.

## Validate Before Finishing

- Confirm every source image token is represented exactly once and no placeholder remains.
- Confirm every screenshot is a descendant of the single task-list item it supports and no detached screenshot gallery or parallel media column remains. Confirm overview and completion pages contain no task lists unless the source demonstrates a real learner action there.
- Confirm exact learner inputs match the available evidence. Verify every typeable block has one copy icon and that it copies the exact text; also verify all pages, checkboxes, quizzes, navigation, progress, and Finish behavior work.
- Confirm `export/web/media/` contains every referenced screenshot and no unreferenced capture.
- Confirm `export/web/guide.html` references `css/guide.css`, `js/guide.js`, and `media/` correctly and contains no inline styling, executable inline script, base64 image, absolute filesystem path, or remote runtime dependency.
- Test direct file opening at desktop and mobile sizes in light and dark themes. Verify local fonts and images load offline, text remains readable, fixed controls do not cover content, and the page has no console errors, failed requests, or horizontal scrolling.
- Do not modify `export/layout.html`, `export/web/css/guide.css`, `export/web/js/guide.js`, or `export/web/fonts/` during ordinary guide regeneration.