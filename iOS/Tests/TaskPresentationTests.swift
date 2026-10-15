import XCTest
import Foundation
@testable import StudentCore

// M1 状态引导：照片卡聚合 / 继续下一道 / 刷新错误分类。全部为合成文档，不接触服务或模型。
final class TaskPresentationTests: XCTestCase {
  static func question(id: Int, status: String) -> String {
    let uuid = String(format: "00000000-0000-4000-8000-%012d", id)
    return """
      {"id":"\(uuid)","number":"\(id)","revision":3,"status":"\(status)","selectionEvidence":"marked_wrong",
      "evidence":{"version":1,"questionNumber":"\(id)","questionText":"求 x 的值。","subject":"数学","chapter":"","knowledgeTags":["方程"],"questionType":"计算","questionRegion":{"x":0.08,"y":0.2,"width":0.84,"height":0.3},"requiresDiagram":false,"regions":[],"observations":[],"uncertainties":[]},
      "verification":{"textComplete":true,"questionCropComplete":true,"questionCropPure":true,"transcriptionMatches":true,"diagramSafe":true,"issues":[]},
      "questionMediaId":"1800c1bc-47ab-42bc-a46d-315005bdc695","diagramMediaIds":[],"error":null,"confirmedAt":null}
      """
  }
  static func job(statuses: [String], jobStatus: String = "completed") throws -> RecognitionJob {
    let questions = statuses.enumerated().map { question(id: $0.offset + 1, status: $0.element) }.joined(separator: ",")
    let json = """
      {"version":1,"id":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","revision":8,"photoName":"Synthetic.jpg","sourceHash":"abc",
      "sourceMediaId":"6ddc034b-b0f8-4288-b9c1-4f496cfb90df","status":"\(jobStatus)","phase":"complete","inventoryWarnings":[],
      "questions":[\(questions)],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}
      """
    return try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(json.utf8))
  }
  static func task(job: RecognitionJob?, consented: Bool = true) -> LocalRecognitionTask {
    LocalRecognitionTask(id: UUID(), photoName: "00000000-0000-4000-8000-000000000099.jpg",
      uploadName: "00000000-0000-4000-8000-000000000099.jpg",
      consentedAt: consented ? Date(timeIntervalSince1970: 1000) : nil, job: job)
  }

  // MARK: 照片卡聚合（精确规则，禁止「无待确认 ⇒ 全部已确认」）

  func testZeroCandidatesCompletedIsNotReportedAsAllConfirmed() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: [])), uploading: false)
    XCTAssertEqual(card.tone, .gray)
    XCTAssertEqual(card.headline, "没有发现可识别的题目")
    XCTAssertFalse(card.headline.contains("已确认"))
    XCTAssertFalse(card.actionable)
  }

  func testZeroCandidatesStillLocatingIsHonestlyProcessing() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: [], jobStatus: "processing")), uploading: false)
    XCTAssertEqual(card.tone, .blue)
    XCTAssertTrue(card.headline.contains("正在识别"))
  }

  func testAllSkippedIsNotConfirmed() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["skipped", "skipped"])), uploading: false)
    XCTAssertEqual(card.tone, .gray)
    XCTAssertEqual(card.headline, "全部已跳过")
    XCTAssertFalse(card.actionable)
  }

  func testConfirmedPlusFailedReportsFailureAndScopedRetry() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["confirmed", "failed"], jobStatus: "partial")), uploading: false)
    XCTAssertEqual(card.tone, .red)
    XCTAssertTrue(card.counts.contains("已确认 1"))
    XCTAssertTrue(card.counts.contains("失败 1"))
    XCTAssertTrue(card.actionable)
  }

  func testReadyQuestionsAreActionableWhileOthersStillProcessing() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["ready", "processing", "queued"], jobStatus: "processing")), uploading: false)
    XCTAssertEqual(card.tone, .orange)
    XCTAssertTrue(card.counts.contains("待核对 1"))
    XCTAssertTrue(card.counts.contains("识别中 2"))
    XCTAssertTrue(card.actionable, "处理中不阻塞：已就绪题可先核对")
  }

  func testUnknownStatusNeedsRefreshAndNeverReadsAllConfirmed() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["legacy_state", "confirmed"])), uploading: false)
    XCTAssertEqual(card.tone, .gray)
    XCTAssertTrue(card.needsRefresh)
    XCTAssertTrue(card.headline.contains("需核对"))
    XCTAssertFalse(card.actionable)
  }

  func testUnknownJobStatusNeverReadsAllConfirmed() throws {
    // 未来新增的任务级状态（如 archived）不得落进「全部已确认」分支。
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["confirmed"], jobStatus: "archived_future")), uploading: false)
    XCTAssertEqual(card.tone, .gray)
    XCTAssertTrue(card.needsRefresh)
    XCTAssertFalse(card.headline.contains("全部已确认"))
    XCTAssertFalse(card.actionable)
  }

  func testInterruptedJobKeepsPerQuestionCounts() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["confirmed", "processing"], jobStatus: "interrupted")), uploading: false)
    XCTAssertEqual(card.tone, .red)
    XCTAssertTrue(card.counts.contains("已确认 1"))
    XCTAssertTrue(card.counts.contains("识别中 1"))
  }

  func testAllConfirmedIsTheOnlyGreen() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["confirmed", "confirmed"])), uploading: false)
    XCTAssertEqual(card.tone, .green)
    XCTAssertEqual(card.headline, "全部已确认")
    XCTAssertFalse(card.actionable)
  }

  func testAllFailedIsRedWithRetryScope() throws {
    let card = TaskPresentation.photoCard(task: Self.task(job: try Self.job(statuses: ["failed", "failed"], jobStatus: "partial")), uploading: false)
    XCTAssertEqual(card.tone, .red)
    XCTAssertTrue(card.headline.contains("没识别成功") || card.headline.contains("失败"))
    XCTAssertTrue(card.actionable)
  }

  func testLocalOnlyAndUploadingStates() throws {
    let local = TaskPresentation.photoCard(task: Self.task(job: nil, consented: false), uploading: false)
    XCTAssertEqual(local.tone, .gray)
    XCTAssertTrue(local.headline.contains("本机"))
    let uploading = TaskPresentation.photoCard(task: Self.task(job: nil), uploading: true)
    XCTAssertEqual(uploading.tone, .blue)
    XCTAssertTrue(uploading.headline.contains("上传"))
  }

  // MARK: 刷新错误分类（lastError 不等于离线）

  func testRefreshIssueClassification() {
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.networkFailure(URLError(.notConnectedToInternet))), .offline)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.networkFailure(URLError(.networkConnectionLost))), .offline)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.networkFailure(URLError(.timedOut))), .serviceUnavailable)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.server(status: 503, message: "x")), .serviceUnavailable)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.server(status: 429, message: "x")), .serviceUnavailable)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.server(status: 401, message: "x")), .unauthorized)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.server(status: 400, message: "x")), .unknown)
    XCTAssertEqual(TaskPresentation.classifyRefreshIssue(RecognitionClientError.invalidResponse), .unknown)
  }

  // MARK: 旧存档兼容：无 lastIssueKind 的任务照常解码

  func testLegacyTaskWithoutIssueKindDecodes() throws {
    let json = """
      {"id":"00000000-0000-4000-8000-0000000000cc","photoName":"00000000-0000-4000-8000-000000000099.jpg",
      "uploadName":"00000000-0000-4000-8000-000000000099.jpg"}
      """
    let task = try RecognitionCodec.decoder().decode(LocalRecognitionTask.self, from: Data(json.utf8))
    XCTAssertNil(task.lastIssueKind)
    XCTAssertNil(task.job)
  }
}
