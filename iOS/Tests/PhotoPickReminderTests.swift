import XCTest
import Foundation
@testable import StudentCore

// S2 RED：主页「勾出错题」入口的纯逻辑——
// 整页无痕迹行 / 识别中的补选按钮 / 「漏了题？从照片里补选」列表。
final class PhotoPickReminderTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let mediaID = "6ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static let photoName = "00000000-0000-4000-8000-00000000000d.jpg"
  static let q1 = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let q2 = "aa16756c-44cc-4a1f-a2dc-93605cbd0b31"
  static let q3 = "1800c1bc-47ab-42bc-a46d-315005bdc695"

  private static func questionJSON(id: String, status: String) -> String {
    #"{"id":"\#(id)","number":"1","revision":1,"status":"\#(status)","selectionEvidence":"unmarked","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":null,"confirmedAt":null}"#
  }

  private static func jobJSON(status: String, phase: String = "complete", questions: [String]) -> String {
    #"{"version":1,"id":"\#(jobID)","revision":2,"photoName":"\#(photoName)","sourceHash":"abc","sourceMediaId":"\#(mediaID)","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  private func task(_ jobJSON: String, pickDone: Bool? = nil) throws -> LocalRecognitionTask {
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(jobJSON.utf8))
    return LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName,
      job: job, pickDone: pickDone)
  }

  // 整页无痕迹（终态、全部 unselected、未处理）→ 显示「这页没看到批改痕迹」行。
  func testNoMarksRowShowsForAllUnselectedTerminalTask() throws {
    let unmarked = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
      Self.questionJSON(id: Self.q2, status: "unselected"),
    ]))
    XCTAssertTrue(PhotoPickReminder.showsNoMarksRow(unmarked))
  }

  // 已点过「这页没有错题」或勾过题（pickDone）→ 不再显示。
  func testNoMarksRowHiddenAfterPickDone() throws {
    let done = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
    ]), pickDone: true)
    XCTAssertFalse(PhotoPickReminder.showsNoMarksRow(done))
  }

  // 有自动题 / 还在找题 / 老服务器（无 unselected）→ 不显示该行。
  func testNoMarksRowHiddenWithAutomaticOrActiveOrLegacy() throws {
    let withAutomatic = try task(Self.jobJSON(status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
      Self.questionJSON(id: Self.q2, status: "confirmed"),
    ]))
    XCTAssertFalse(PhotoPickReminder.showsNoMarksRow(withAutomatic), "有自动题不显示整页无痕迹行")
    let locating = try task(Self.jobJSON(status: "processing", phase: "inventory", questions: []))
    XCTAssertFalse(PhotoPickReminder.showsNoMarksRow(locating))
    let legacy = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "confirmed"),
    ]))
    XCTAssertFalse(PhotoPickReminder.showsNoMarksRow(legacy), "旧服务器的照片行为不变")
  }

  // 识别中且有自动题：行内补选按钮给出未选题数；没有自动题或未选题时不显示。
  func testPickMoreCountOnlyWhileRecognizingWithAutomaticQuestions() throws {
    let mixed = try task(Self.jobJSON(status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
      Self.questionJSON(id: Self.q2, status: "unselected"),
      Self.questionJSON(id: Self.q3, status: "processing"),
    ]))
    XCTAssertEqual(PhotoPickReminder.pickMoreCount(mixed), 2)
    let noAutomatic = try task(Self.jobJSON(status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
    ]))
    XCTAssertNil(PhotoPickReminder.pickMoreCount(noAutomatic), "一道自动题都没有时不单独催")
    let terminal = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
      Self.questionJSON(id: Self.q2, status: "confirmed"),
    ]))
    XCTAssertNil(PhotoPickReminder.pickMoreCount(terminal), "识别完成后这一行照常消失")
  }

  // 补选入口：还有未选题、且行内没有别的勾选入口的照片。
  func testMissedTasksExcludesRowsThatAlreadyOfferPicking() throws {
    let noMarks = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected"),
    ]))
    let partialJob = try RecognitionCodec.decoder().decode(RecognitionJob.self,
      from: Data(Self.jobJSON(status: "completed", questions: [
        Self.questionJSON(id: Self.q1, status: "unselected"),
        Self.questionJSON(id: Self.q2, status: "confirmed"),
      ]).utf8))
    let partial = LocalRecognitionTask(id: UUID(), photoName: Self.photoName,
      uploadName: Self.photoName, job: partialJob, pickDone: true)
    XCTAssertTrue(PhotoPickReminder.missedTasks([noMarks]).isEmpty,
      "整页无痕迹行已在催，不重复列入补选")
    XCTAssertEqual(PhotoPickReminder.missedTasks([partial]).map(\.id), [partial.id],
      "勾过题但还剩未选题的照片进入补选列表")
    let legacy = try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "confirmed"),
    ]))
    XCTAssertTrue(PhotoPickReminder.missedTasks([legacy]).isEmpty, "旧服务器的照片不进补选")
  }
}
