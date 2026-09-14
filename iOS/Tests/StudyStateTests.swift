import XCTest

@testable import StudentCore

final class StudyStateTests: XCTestCase {
  func completeDraft(revisit: Bool = true) -> ReflectionDraft {
    ReflectionDraft(
      attempt: "I had a plan", takeaway: "Check each calculation", confidence: "With a hint",
      revisit: revisit)
  }

  func testNewReflectionDoesNotInventAnswers() {
    let draft = ReflectionDraft()
    XCTAssertNil(draft.attempt)
    XCTAssertNil(draft.revisit)
    XCTAssertNil(draft.submittedAt)
    XCTAssertFalse(draft.isComplete)
  }

  func testIncompleteReflectionCannotBeSubmitted() {
    var state = StudyState()
    state.drafts["5516-14"] = ReflectionDraft(attempt: "I had a plan")
    XCTAssertThrowsError(try state.submit("5516-14"))
    XCTAssertNil(state.drafts["5516-14"]?.submittedAt)
  }

  func testCompleteReflectionRequiresExplicitSubmitAndSelection() throws {
    var state = StudyState()
    state.drafts["5516-14"] = completeDraft()
    XCTAssertTrue(state.drafts["5516-14"]!.isComplete)
    XCTAssertNil(state.drafts["5516-14"]?.submittedAt)
    XCTAssertThrowsError(try state.select("5516-14", selected: true))
    try state.submit("5516-14", at: Date(timeIntervalSince1970: 100))
    XCTAssertEqual(state.drafts["5516-14"]?.submittedAt, Date(timeIntervalSince1970: 100))
    XCTAssertTrue(state.selectedIDs.isEmpty)
    try state.select("5516-14", selected: true)
    XCTAssertEqual(state.selectedIDs, ["5516-14"])
  }

  func testEmptyAndUnreflectedPacksAreRejected() {
    var state = StudyState()
    XCTAssertThrowsError(try state.makePack())
    state.selectedIDs = ["5516-14"]
    XCTAssertThrowsError(try state.makePack())
  }

  func testPackIsSnapshotOfOnlyDeliberatelySelectedProblems() throws {
    var state = StudyState()
    for id in ["5516-14", "5518-13"] {
      state.drafts[id] = completeDraft()
      try state.submit(id)
    }
    try state.select("5516-14", selected: true)
    let pack = try state.makePack()
    XCTAssertEqual(pack.problemIDs, ["5516-14"])
    XCTAssertEqual(state.packs.count, 1)
    XCTAssertTrue(pack.outcomes.isEmpty, "Making a pack is not evidence of mastery")
    try state.select("5516-14", selected: false)
    XCTAssertEqual(state.packs.first?.problemIDs, ["5516-14"])
  }

  func testDraftAndLocalImportSurviveCodableRoundTrip() throws {
    var state = StudyState()
    state.drafts["5518-13"] = ReflectionDraft(
      attempt: "I was unsure", note: "Need to revisit roots")
    state.importedPhotos = [UUID().uuidString + ".jpg"]
    let restored = try JSONDecoder().decode(StudyState.self, from: JSONEncoder().encode(state))
    XCTAssertEqual(restored, state)
    XCTAssertNil(restored.drafts["5518-13"]?.submittedAt)
    XCTAssertEqual(restored.drafts.count, 1, "Import does not fabricate a new extracted problem")
  }

  func testChineseChoiceDisplayDoesNotRewriteSavedEnglishValuesOrNote() throws {
    var state = StudyState()
    state.drafts["5516-14"] = ReflectionDraft(
      attempt: "I had a plan",
      takeaway: "Check each calculation",
      confidence: "With a hint",
      revisit: true,
      note: "Keep my exact note")

    let restored = try JSONDecoder().decode(StudyState.self, from: JSONEncoder().encode(state))

    XCTAssertEqual(restored.drafts["5516-14"]?.attempt, "I had a plan")
    XCTAssertEqual(restored.drafts["5516-14"]?.note, "Keep my exact note")
    let expectedTitles = [
      "I had a plan": "当时有思路",
      "I got stuck partway": "做到一半卡住了",
      "I was unsure": "一开始就没把握",
      "Check each calculation": "检查每一步计算",
      "Choose a different method": "换一种方法",
      "Read the question more carefully": "先读清题目条件",
      "I’m not sure yet": "还没想清楚",
      "On my own": "能独立完成",
      "With a hint": "需要一点提示",
      "I need to learn it again": "还要再学一下",
      "I solved it independently": "这次独立做出来了",
      "I needed a hint": "看了提示才做出来",
      "I’m still working on it": "还没有做出来",
    ]
    for (storedValue, displayTitle) in expectedTitles {
      XCTAssertEqual(ReflectionOptions.displayTitle(for: storedValue), displayTitle)
    }
    XCTAssertEqual(ReflectionOptions.displayTitle(for: "unmapped saved value"), "unmapped saved value")
  }

  func testEditingSubmittedReflectionRequiresResubmission() throws {
    var state = StudyState()
    state.drafts["5516-14"] = completeDraft()
    try state.submit("5516-14")
    try state.select("5516-14", selected: true)
    var edited = state.drafts["5516-14"]!
    edited.note = "I changed my mind"
    state.updateDraft("5516-14", draft: edited)
    XCTAssertNil(state.drafts["5516-14"]?.submittedAt)
    XCTAssertTrue(state.selectedIDs.isEmpty)
  }

  func testUnknownQuestionAndInvalidChoicesAreRejected() {
    var state = StudyState()
    state.drafts["invented"] = completeDraft()
    XCTAssertThrowsError(try state.submit("invented"))
    state.drafts["5516-14"] = ReflectionDraft(
      attempt: "", takeaway: "invented", confidence: "", revisit: true)
    XCTAssertThrowsError(try state.submit("5516-14"))
  }

  func testDiskPersistenceAndCorruptionNeverSilentlyReset() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let persistence = StudyPersistence(directory: folder)
    XCTAssertEqual(try persistence.load(), StudyState())
    var state = StudyState()
    state.drafts["5516-14"] = completeDraft()
    try persistence.save(state)
    XCTAssertEqual(try persistence.load(), state)
    let corrupt = Data("not valid JSON".utf8)
    try corrupt.write(to: persistence.stateURL)
    XCTAssertThrowsError(try persistence.load())
    XCTAssertEqual(try Data(contentsOf: persistence.stateURL), corrupt)
  }

  func testSubmitUsesDisplayedDraftInsteadOfLastSuccessfullyAutosavedDraft() throws {
    var state = StudyState()
    state.drafts["5516-14"] = completeDraft()
    var displayed = completeDraft()
    displayed.note = "This is my latest thought"
    try state.submit("5516-14", draft: displayed)
    XCTAssertEqual(state.drafts["5516-14"]?.note, "This is my latest thought")
  }

  func testLocalCollectionIsExcludedFromCloudBackup() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let persistence = StudyPersistence(directory: folder)
    try persistence.save(StudyState())
    XCTAssertEqual(
      try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    try persistence.save(StudyState())
    XCTAssertEqual(
      try persistence.stateURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        .isExcludedFromBackup, true)
  }
}
