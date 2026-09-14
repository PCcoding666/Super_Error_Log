# iPhone student experience — approved direction

Date: 2026-09-12. Approval: user requested the native implementation and English main interaction pages.

Language update, 2026-09-14: the user now requests Chinese main interactions. The historical prototype description below records the original delivery; all upcoming live-recognition work follows `2026-09-14-iphone-live-recognition-design.md` and uses Simplified Chinese. Existing saved work must remain compatible.

## Outcome

A student can spend a short weekend session reflecting on a few real mistakes, prepare a clean paper practice pack, and return later to record an independent attempt. The student is not an OCR auditor and AI must not invent the student's reflection.

## First delivery

An independent SwiftUI Xcode project under `iOS/`. Three tabs: **This Week**, **Reflect**, **Review Pack**. Navigation, questions, actions, states and errors are English; original Chinese maths is preserved. Use warm paper, dark ink, teal accents, generous cards and native controls. Support Dynamic Type and VoiceOver labels.

This is explicitly an interactive prototype with three prepared examples from the user's real photographs, not a completed AI extraction service. Full original images remain inspectable. New imports are saved locally and visibly await a connected recognition service; they never turn into canned results.

## Student journey

1. This Week: a clear next action, honest progress and photo import (camera on a physical device, library on simulator/device).
2. Reflect: one problem and one short prompt at a time. Student chooses attempt state, a personal takeaway, confidence and whether to revisit. No preselected answers. Drafts save automatically; a separate explicit submit completes reflection. Original photo is always available.
3. Review Pack: student selects completed reflections, previews a clean PDF with working space, and shares/prints it. Paper contains printed questions, not old working, corrections or solutions.
4. Later: record whether a paper attempt was independent, needed help, or unfinished. These are self-reports, never an automatic mastery verdict.

## Boundaries

- Local persistence, no accounts, cloud syncing, keys, model calls or private-photo uploads.
- Source text is curated prototype material, not evidence that crop grounding is fixed or every photo has passed acceptance.
- Model benchmarking stays independent. Future backend adapter must carry real source evidence, partial failures and uncertainty into appropriate student actions.
- Do not restore or edit deleted legacy iOS files, change the web app, reset databases, change global Xcode selection, or commit/push.
- Directory isolation in the existing user-approved checkout; no new git worktree is claimed.

## Acceptance

- Build and launch a native simulator app; English UI and real example images render.
- Fresh reflections have no answers chosen; incomplete submission is rejected; drafts survive reload.
- Only deliberately selected, completed reflections enter a PDF. Export is non-empty and has real Chinese question text and working space without answers.
- Imports remain local and visibly unprocessed. Persisted-state read failures do not silently destroy data.
- A student can finish a reflection, make a pack and record a self-reported redo through the UI.
- Unit tests plus simulator UI checks, screenshots and an honest device/version matrix accompany handoff.
