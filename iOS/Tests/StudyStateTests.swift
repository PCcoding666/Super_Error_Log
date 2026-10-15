import XCTest

@testable import StudentCore

final class StudyStateTests: XCTestCase {
  func testNewReflectionDoesNotInventAnswers() {
    let draft = ReflectionDraft()
    XCTAssertNil(draft.attempt)
    XCTAssertNil(draft.revisit)
    XCTAssertNil(draft.submittedAt)
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

  func testDiskPersistenceAndCorruptionNeverSilentlyReset() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let persistence = StudyPersistence(directory: folder)
    XCTAssertEqual(try persistence.load(), StudyState())
    var state = StudyState()
    state.drafts["5516-14"] = ReflectionDraft(attempt: "I had a plan")
    try persistence.save(state)
    XCTAssertEqual(try persistence.load(), state)
    let corrupt = Data("not valid JSON".utf8)
    try corrupt.write(to: persistence.stateURL)
    XCTAssertThrowsError(try persistence.load())
    XCTAssertEqual(try Data(contentsOf: persistence.stateURL), corrupt)
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

  // T6f：v2 不再写入 drafts/selectedIDs/packs/realProblems，但旧存档必须仍能打开——
  // 照片与识别任务都在，旧复盘草稿与练习包原样保留（示例题快照经 SampleProblem 回填）。
  func testLegacyArchiveStillDecodesWithPhotosAndRecognitionTasksIntact() throws {
    let photoName = "00000000-0000-4000-8000-000000000001.jpg"
    let json = """
      {"schemaVersion":1,
      "drafts":{"5516-14":{"attempt":"I had a plan","note":"My original note"}},
      "selectedIDs":["5516-14"],
      "packs":[{"id":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","createdAt":0,"problemIDs":["5516-14"],"outcomes":{}}],
      "importedPhotos":["\(photoName)"],
      "recognitionTasks":[{"id":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","photoName":"\(photoName)","uploadName":"\(photoName)"}]}
      """
    let decoded = try JSONDecoder().decode(StudyState.self, from: Data(json.utf8))
    XCTAssertEqual(decoded.importedPhotos, [photoName], "旧存档的照片不丢")
    XCTAssertEqual(decoded.recognitionTasks.count, 1, "旧存档的识别任务不丢")
    XCTAssertEqual(decoded.recognitionTasks[0].photoName, photoName)
    XCTAssertNil(decoded.recognitionTasks[0].v2Registered, "旧存档无登记字段，解码为未登记")
    XCTAssertEqual(decoded.drafts["5516-14"]?.note, "My original note", "旧复盘草稿原样保留")
    XCTAssertEqual(decoded.selectedIDs, ["5516-14"])
    XCTAssertEqual(decoded.packs.count, 1)
    XCTAssertTrue(decoded.packs[0].problemSnapshots[0].isExample, "示例题快照经 SampleProblem 回填")
    XCTAssertFalse(decoded.uploadConsentGranted, "旧存档无同意键，解码为未同意")
    XCTAssertEqual(decoded.schemaVersion, 2)
  }
}
