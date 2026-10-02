import XCTest
import Foundation
@testable import StudentCore

// S2 RED：模型与呈现层对「未选」的支持——
// selectedByStudent 可选字段（旧服务器/旧存档没有）；unselected 是已知状态，
// 不算「状态需核对」也不算识别中/失败/完成；PhotoFailurePlan 计数不含未选题；
// LocalRecognitionTask 新增持久字段 pickDone（旧存档解码为 nil）。
final class UnselectedModelTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let mediaID = "6ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static let photoName = "00000000-0000-4000-8000-00000000000b.jpg"
  static let q1 = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let q2 = "aa16756c-44cc-4a1f-a2dc-93605cbd0b31"

  private static func questionJSON(id: String, status: String, number: String = "1",
    selectedByStudent: Bool? = nil, error: String = "null") -> String {
    let selected = selectedByStudent.map { #","selectedByStudent":\#($0)"# } ?? ""
    return #"{"id":"\#(id)","number":"\#(number)","revision":1,"status":"\#(status)","selectionEvidence":"unmarked","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":\#(error),"confirmedAt":null\#(selected)}"#
  }

  private static func jobJSON(status: String, phase: String = "complete", questions: [String] = []) -> String {
    #"{"version":1,"id":"\#(jobID)","revision":2,"photoName":"\#(photoName)","sourceHash":"abc","sourceMediaId":"\#(mediaID)","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  private func task(_ jobJSON: String) throws -> LocalRecognitionTask {
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(jobJSON.utf8))
    return LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName, job: job)
  }

  // selectedByStudent：有则解码，旧文档（无此键）解码为 nil，不拒绝加载。
  func testSelectedByStudentDecodesWhenPresentAndNilForOldDocuments() throws {
    let withFlag = try RecognitionCodec.decoder().decode(RecognitionJob.self,
      from: Data(Self.jobJSON(status: "processing", phase: "questions", questions: [
        Self.questionJSON(id: Self.q1, status: "queued", selectedByStudent: true),
      ]).utf8))
    XCTAssertEqual(withFlag.questions[0].selectedByStudent, true)
    let old = try RecognitionCodec.decoder().decode(RecognitionJob.self,
      from: Data(Self.jobJSON(status: "completed", questions: [
        Self.questionJSON(id: Self.q1, status: "confirmed"),
      ]).utf8))
    XCTAssertNil(old.questions[0].selectedByStudent, "旧服务器不下发该字段，解码为 nil")
  }

  // unselected 是已知状态：不算「状态需核对」，也不算识别中、失败或完成。
  func testUnselectedIsKnownAndNotCountedAsUnknownOrActive() throws {
    let job = try Self.decode(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected", number: "1"),
      Self.questionJSON(id: Self.q2, status: "unselected", number: "2"),
    ]))
    let card = TaskPresentation.photoCard(task: try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected", number: "1"),
      Self.questionJSON(id: Self.q2, status: "unselected", number: "2"),
    ])), uploading: false)
    XCTAssertFalse(card.needsRefresh, "unselected 不得算「状态需核对」")
    XCTAssertFalse(card.counts.contains("状态需核对"), "计数不含状态需核对")
    XCTAssertFalse(card.counts.contains("识别中"), "未选不算识别中")
    XCTAssertFalse(card.counts.contains("失败"), "未选不算失败")
    XCTAssertFalse(card.counts.contains("已确认"), "未选不算完成")
    XCTAssertFalse(job.questions[0].active, "unselected 不是进行中状态")
  }

  private static func decode(_ json: String) throws -> RecognitionJob {
    try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(json.utf8))
  }

  // PhotoFailurePlan：未选的题不参与「全部失败 / 部分失败 / 其余 M 道已进错题本」的计数。
  func testFailurePlanExcludesUnselectedQuestions() throws {
    // 3 题里 2 题未选、1 题失败：是「全部失败」（1/1），不是「部分失败 · 其余 2 道已进错题本」。
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task(Self.jobJSON(status: "failed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected", number: "1"),
      Self.questionJSON(id: Self.q2, status: "unselected", number: "2"),
      Self.questionJSON(id: "1800c1bc-47ab-42bc-a46d-315005bdc695", status: "failed", number: "3",
        error: #"{"code":"vision_failed","message":"超时","stage":"transcribe","retryable":false,"recoverable":true}"#),
    ]))))
    XCTAssertEqual(plan.title, "1 道都没认出来", "未选题不算进总数")
    XCTAssertEqual(plan.retryQuestionIDs, ["1800c1bc-47ab-42bc-a46d-315005bdc695"])
    // 全部未选：没有任何失败方案。
    XCTAssertNil(PhotoFailurePlan.plan(for: try task(Self.jobJSON(status: "completed", questions: [
      Self.questionJSON(id: Self.q1, status: "unselected", number: "1"),
      Self.questionJSON(id: Self.q2, status: "unselected", number: "2"),
    ]))), "全部未选的照片不产生失败方案")
  }

  // pickDone：旧存档解码为 nil；置位后往返一致。
  func testPickDoneDecodesNilFromOldArchiveAndRoundTrips() throws {
    let oldJSON = #"{"id":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","photoName":"00000000-0000-4000-8000-00000000000b.jpg","uploadName":"00000000-0000-4000-8000-00000000000b.jpg"}"#
    let decoded = try JSONDecoder().decode(LocalRecognitionTask.self, from: Data(oldJSON.utf8))
    XCTAssertNil(decoded.pickDone, "旧存档无该键解码为 nil")
    var task = decoded
    task.pickDone = true
    let roundTrip = try JSONDecoder().decode(LocalRecognitionTask.self, from: JSONEncoder().encode(task))
    XCTAssertEqual(roundTrip.pickDone, true)
  }
}
