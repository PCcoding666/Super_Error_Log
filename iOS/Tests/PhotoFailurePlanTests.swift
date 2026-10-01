import XCTest
import Foundation
@testable import StudentCore

// T6k RED：照片没识别成功时学生看到什么、能点什么（纯逻辑，不连服务）。
final class PhotoFailurePlanTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let mediaID = "6ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static let photoName = "00000000-0000-4000-8000-00000000000a.jpg"
  static let q1 = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let q2 = "aa16756c-44cc-4a1f-a2dc-93605cbd0b31"
  static let q3 = "1800c1bc-47ab-42bc-a46d-315005bdc695"

  private static func failureJSON(stage: String, message: String, recoverable: Bool?) -> String {
    let recoverableField = recoverable.map { #","recoverable":\#($0)"# } ?? ""
    return #"{"code":"vision_failed","message":"\#(message)","stage":"\#(stage)","retryable":false\#(recoverableField)}"#
  }

  private static func questionJSON(id: String, status: String, error: String = "null") -> String {
    #"{"id":"\#(id)","number":"1","revision":1,"status":"\#(status)","selectionEvidence":"marked_wrong","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":\#(error),"confirmedAt":null}"#
  }

  private static func jobJSON(status: String, phase: String = "questions", error: String = "null",
    questions: [String] = []) -> String {
    #"{"version":1,"id":"\#(jobID)","revision":2,"photoName":"\#(photoName)","sourceHash":"abc","sourceMediaId":"\#(mediaID)","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":\#(error),"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  private func task(_ jobJSON: String) throws -> LocalRecognitionTask {
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(jobJSON.utf8))
    return LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName, job: job)
  }

  // 1. 找题目失败、可恢复：整张再试一次 + 可移除。
  func testInventoryFailureRecoverableOffersWholePhotoRetryAndDismiss() throws {
    let task = try task(Self.jobJSON(status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", message: "照片太模糊", recoverable: true)))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张没识别成功")
    XCTAssertEqual(plan.detail, "可以再试一次（会重新请求 AI）")
    XCTAssertEqual(plan.retryTitle, "再试一次")
    XCTAssertEqual(plan.dismissTitle, "移除这张")
    XCTAssertTrue(plan.retryWholePhoto, "找题目失败的再试一次是整张重试")
  }

  // 2. 找题目失败、不可恢复：给服务器原因 + 重拍建议，只能移除。
  func testInventoryFailureNotRecoverableOnlyDismissWithReasonAndRetakeAdvice() throws {
    let task = try task(Self.jobJSON(status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", message: "这不是一页作业", recoverable: false)))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张识别不了")
    XCTAssertTrue(plan.detail.contains("这不是一页作业"), "说明要带上服务器给的原因")
    XCTAssertTrue(plan.detail.contains("请重拍一张更清楚的"))
    XCTAssertNil(plan.retryTitle)
    XCTAssertFalse(plan.retryWholePhoto)
    XCTAssertEqual(plan.dismissTitle, "移除这张")
  }

  // 3. 题目全部失败、至少一道可恢复：只重试失败的题 + 可移除。
  func testAllQuestionsFailedWithRecoverableOffersPerQuestionRetry() throws {
    let task = try task(Self.jobJSON(status: "failed", questions: [
      Self.questionJSON(id: Self.q1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", message: "超时", recoverable: true)),
      Self.questionJSON(id: Self.q2, status: "failed",
        error: Self.failureJSON(stage: "transcribe", message: "超时", recoverable: true)),
    ]))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "2 道都没认出来")
    XCTAssertEqual(plan.detail, "可以再试一次（只重试失败的题）")
    XCTAssertEqual(plan.retryTitle, "再试一次")
    XCTAssertEqual(plan.retryQuestionIDs, [Self.q1, Self.q2], "只重试失败的题，不做整张重试")
    XCTAssertFalse(plan.retryWholePhoto)
    XCTAssertEqual(plan.dismissTitle, "移除这张")
  }

  // 4. 题目全部失败、都不可恢复：只能移除。
  func testAllQuestionsFailedNoneRecoverableOnlyDismiss() throws {
    let task = try task(Self.jobJSON(status: "failed",
      error: Self.failureJSON(stage: "questions", message: "内容无法辨认", recoverable: false),
      questions: [
        Self.questionJSON(id: Self.q1, status: "failed",
          error: Self.failureJSON(stage: "transcribe", message: "内容无法辨认", recoverable: false)),
      ]))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张识别不了")
    XCTAssertTrue(plan.detail.contains("内容无法辨认"))
    XCTAssertTrue(plan.detail.contains("请重拍一张更清楚的"))
    XCTAssertNil(plan.retryTitle)
    XCTAssertEqual(plan.dismissTitle, "移除这张")
  }

  // 5. 部分失败、至少一道可恢复：重试这 N 道 / 不管了；说明其余已进错题本。
  func testPartialFailureWithRecoverableOffersRetryThoseAndIgnore() throws {
    let task = try task(Self.jobJSON(status: "partial", questions: [
      Self.questionJSON(id: Self.q1, status: "confirmed"),
      Self.questionJSON(id: Self.q2, status: "confirmed"),
      Self.questionJSON(id: Self.q3, status: "failed",
        error: Self.failureJSON(stage: "transcribe", message: "超时", recoverable: true)),
    ]))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张有 1 道没认出来")
    XCTAssertEqual(plan.detail, "其余 2 道已进错题本")
    XCTAssertEqual(plan.retryTitle, "重试这 1 道")
    XCTAssertEqual(plan.retryQuestionIDs, [Self.q3])
    XCTAssertEqual(plan.dismissTitle, "不管了")
  }

  // 6. 部分失败、都不可恢复：只有「知道了」；说明单独重拍。
  func testPartialFailureNoneRecoverableOnlyAcknowledge() throws {
    let task = try task(Self.jobJSON(status: "partial", questions: [
      Self.questionJSON(id: Self.q1, status: "confirmed"),
      Self.questionJSON(id: Self.q2, status: "failed",
        error: Self.failureJSON(stage: "transcribe", message: "内容无法辨认", recoverable: false)),
      Self.questionJSON(id: Self.q3, status: "failed",
        error: Self.failureJSON(stage: "verify", message: "内容无法辨认", recoverable: false)),
    ]))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张有 2 道没认出来")
    XCTAssertTrue(plan.detail.contains("其余 1 道已进错题本"))
    XCTAssertTrue(plan.detail.contains("需要的话把它们单独重拍"))
    XCTAssertNil(plan.retryTitle)
    XCTAssertEqual(plan.dismissTitle, "知道了")
  }

  // 7. 识别中断：说明回前台自动继续，可再试一次、可移除。
  func testInterruptedOffersRetryAndDismissWithAutoResumeNote() throws {
    let task = try task(Self.jobJSON(status: "interrupted", questions: [
      Self.questionJSON(id: Self.q1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", message: "服务重启", recoverable: true)),
    ]))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "识别中断了")
    XCTAssertTrue(plan.detail.contains("回到前台会自动继续"))
    XCTAssertEqual(plan.retryTitle, "再试一次")
    XCTAssertEqual(plan.retryQuestionIDs, [Self.q1])
    XCTAssertEqual(plan.dismissTitle, "移除这张")
  }

  // 中断在找题目阶段且可恢复：再试一次是整张重试（服务器只在这时接受整张重试）。
  func testInterruptedAtInventoryRetriesWholePhoto() throws {
    let task = try task(Self.jobJSON(status: "interrupted", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", message: "服务重启", recoverable: true)))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "识别中断了")
    XCTAssertTrue(plan.retryWholePhoto)
  }

  // 没有任何失败时不产出方案。
  func testNoFailureProducesNoPlan() throws {
    let completed = try task(Self.jobJSON(status: "completed", phase: "complete", questions: [
      Self.questionJSON(id: Self.q1, status: "confirmed"),
    ]))
    XCTAssertNil(PhotoFailurePlan.plan(for: completed))
    let active = try task(Self.jobJSON(status: "processing", questions: [
      Self.questionJSON(id: Self.q1, status: "processing"),
    ]))
    XCTAssertNil(PhotoFailurePlan.plan(for: active))
    let noJob = LocalRecognitionTask(id: UUID(), photoName: Self.photoName, uploadName: Self.photoName)
    XCTAssertNil(PhotoFailurePlan.plan(for: noJob))
  }

  // 服务器给的原因为空时用通用句。
  func testEmptyServerReasonFallsBackToGenericSentence() throws {
    let task = try task(Self.jobJSON(status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", message: "  ", recoverable: false)))
    let plan = try XCTUnwrap(PhotoFailurePlan.plan(for: task))
    XCTAssertEqual(plan.title, "这张识别不了")
    XCTAssertTrue(plan.detail.contains("AI 没能读出这张照片"), "原因为空时用通用句")
    XCTAssertTrue(plan.detail.contains("请重拍一张更清楚的"))
  }
}
