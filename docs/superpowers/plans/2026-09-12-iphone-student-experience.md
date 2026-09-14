# iPhone Student Experience Implementation Plan

> For agentic workers: use Superpowers executing-plans and test-driven-development. Execute in the main session as requested; request an independent code review before handoff.

**Goal:** Deliver the approved student-facing native prototype with English interaction pages.

**Architecture:** SwiftUI app; a Foundation-only domain library with behavior tests; observable local state, atomic JSON persistence and local photo storage; UIKit PDF renderer and PDFKit preview; no AI gateway in the client.

**Tech stack:** Swift, SwiftUI, PhotosUI, UIKit, PDFKit, XCTest, Xcode 26.6. iOS 18 minimum.

**Spec:** `docs/superpowers/specs/2026-09-12-iphone-student-experience-design.md`.

**Global constraints:** Preserve all unrelated dirty changes and deleted legacy files. Work only in new `iOS/` and these docs. No secrets, cloud upload, database reset, commit, global Xcode changes or fake AI results. Private photo copies/build output stay ignored.

## Tasks

- [x] 1. Add `iOS/Package.swift`, domain tests and a minimal Xcode project. Run failing behavior tests for reflection validation, selection, persistence and redo semantics.
- [x] 2. Implement `StudentApp/Domain/StudyState.swift`, curated examples and atomic persistence. Run tests to green, including invalid state/import safety.
- [x] 3. Implement app store, theme, This Week, stepped reflection and source viewer. Save drafts on every edit and support resuming.
- [x] 4. Add real library/camera import with an explicit local-only awaiting-service state. Add selected clean-question PDF generation, preview/share and paper attempt recording. Camera wrapper is implemented; physical-device capture remains unverified.
- [x] 5. Build/install/launch on available iPhone simulators. Exercise the student loop via XCUITest, capture and inspect screenshots; test PDF contents and page count.
- [x] 6. Request bounded independent review, address findings, rerun checks. Write `iOS/README.md` with build, verification matrix, boundaries and the next backend milestone.

Final evidence: 11 domain tests; iPhone 17 Pro / iOS 26.3.1 all 4 UI tests green in `iOS/build/ui-complete.xcresult`; iPhone 16 / iOS 18.6 all 3 applicable UI tests green in `iOS/build/ui-iphone16-verified.xcresult`. No reset, commit, signing change, runtime install or global Xcode change. See `iOS/VERIFICATION.md` for preserved failures and scope limits.

## Verification commands

Use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` per process. Run `swift test` inside `iOS/`, then `xcodebuild build` and `xcodebuild test` for `SuperErrorLog.xcodeproj` / `SuperErrorLog` against an available iPhone simulator. Never use the web project's database-resetting verification commands.
