import XCTest
import Foundation
@testable import StudentCore

// T6k RED：retryFailed 按方案重试（整张 / 逐题，失败即停、busy 去重）；
// dismissPhoto 只把照片移出进度区（照片文件、识别任务、已进错题本的题都不动），持久化且旧存档可解码。
@MainActor final class StudyStoreRetryFailedTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let mediaID = "6ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static let photoName = "00000000-0000-4000-8000-00000000000a.jpg"
  static let q1 = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let q2 = "aa16756c-44cc-4a1f-a2dc-93605cbd0b31"
  static let retryPath = "/v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/retry"

  override func setUp() { LoopSyntheticProtocol.reset() }

  private static func failureJSON(stage: String, recoverable: Bool) -> String {
    #"{"code":"vision_failed","message":"识别超时","stage":"\#(stage)","retryable":false,"recoverable":\#(recoverable)}"#
  }

  private static func questionJSON(id: String, revision: Int, status: String, error: String = "null") -> String {
    #"{"id":"\#(id)","number":"1","revision":\#(revision),"status":"\#(status)","selectionEvidence":"marked_wrong","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":\#(error),"confirmedAt":null}"#
  }

  private static func jobJSON(revision: Int, status: String, phase: String = "questions",
    error: String = "null", questions: [String] = []) -> String {
    #"{"version":1,"id":"\#(jobID)","revision":\#(revision),"photoName":"\#(photoName)","sourceHash":"abc","sourceMediaId":"\#(mediaID)","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":\#(error),"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  private func makeStore(jobJSON: String) throws -> (StudyStore, StudyPersistence) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("RetryFailed-" + UUID().uuidString)
    let persistence = StudyPersistence(directory: directory)
    try persistence.prepareDirectory()
    var state = StudyState()
    state.importedPhotos = [Self.photoName]
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(jobJSON.utf8))
    try state.ingest(job, photoName: Self.photoName)
    try persistence.save(state)
    let photos = directory.appendingPathComponent("Photos")
    try FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
    try StoreHTTPProtocol.jpeg.write(to: photos.appendingPathComponent(Self.photoName))
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3198", token: "synthetic-retry-16")
    let store = StudyStore(
      persistence: persistence,
      client: RecognitionClient(configuration: pairing, sessionConfiguration: sessionConfiguration))
    return (store, persistence)
  }

  private func retryRequests() -> [URLRequest] {
    LoopSyntheticProtocol.requests(method: "POST", path: Self.retryPath)
  }

  private func questionIDSent(_ request: URLRequest) -> String? {
    guard let body = request.httpBody,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return "?" }
    if object["questionId"] is NSNull { return nil }
    return object["questionId"] as? String
  }

  // 找题目失败且可恢复 → 整张重试（questionId 为 null，与 retryPhoto 同一请求）。
  func testInventoryFailureRecoverableRetriesWholePhoto() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", recoverable: true))
    let (store, _) = try makeStore(jobJSON: failed)
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let recovered = Self.jobJSON(revision: 2, status: "processing", phase: "inventory")
    LoopSyntheticProtocol.respond("POST", Self.retryPath, status: 202, body: "{\"job\":" + recovered + "}")
    await store.retryFailed(taskID: taskID)
    XCTAssertEqual(retryRequests().count, 1)
    XCTAssertNil(questionIDSent(try XCTUnwrap(retryRequests().first)), "整张重试 questionId 必须是 null")
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.revision, 2, "成功后 ingest 新任务")
    XCTAssertNil(store.errorMessage)
  }

  // 找到题目但全部失败且可恢复 → 依次逐题重试（只发失败的题），不做整张重试。
  func testAllQuestionsFailedRetriesEachRecoverableQuestion() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed", questions: [
      Self.questionJSON(id: Self.q1, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
      Self.questionJSON(id: Self.q2, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
    ])
    let (store, _) = try makeStore(jobJSON: failed)
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let afterFirst = Self.jobJSON(revision: 2, status: "partial", questions: [
      Self.questionJSON(id: Self.q1, revision: 2, status: "ready"),
      Self.questionJSON(id: Self.q2, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
    ])
    let afterSecond = Self.jobJSON(revision: 3, status: "completed", phase: "complete", questions: [
      Self.questionJSON(id: Self.q1, revision: 2, status: "ready"),
      Self.questionJSON(id: Self.q2, revision: 2, status: "ready"),
    ])
    LoopSyntheticProtocol.enqueue("POST", Self.retryPath, status: 202, body: "{\"job\":" + afterFirst + "}")
    LoopSyntheticProtocol.enqueue("POST", Self.retryPath, status: 202, body: "{\"job\":" + afterSecond + "}")
    await store.retryFailed(taskID: taskID)
    XCTAssertEqual(retryRequests().count, 2)
    XCTAssertEqual(questionIDSent(retryRequests()[0]), Self.q1)
    XCTAssertEqual(questionIDSent(retryRequests()[1]), Self.q2)
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.revision, 3)
    XCTAssertNil(store.errorMessage)
  }

  // 任一请求失败就停下并给出错误：第一题重试成功保留，第二题失败后不再继续。
  func testPerQuestionRetryStopsAtFirstFailureKeepingSuccesses() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed", questions: [
      Self.questionJSON(id: Self.q1, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
      Self.questionJSON(id: Self.q2, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
    ])
    let (store, _) = try makeStore(jobJSON: failed)
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let afterFirst = Self.jobJSON(revision: 2, status: "partial", questions: [
      Self.questionJSON(id: Self.q1, revision: 2, status: "ready"),
      Self.questionJSON(id: Self.q2, revision: 1, status: "failed",
        error: Self.failureJSON(stage: "transcribe", recoverable: true)),
    ])
    LoopSyntheticProtocol.enqueue("POST", Self.retryPath, status: 202, body: "{\"job\":" + afterFirst + "}")
    LoopSyntheticProtocol.enqueue("POST", Self.retryPath, status: 500,
      body: #"{"error":{"code":"invalid_request","message":"服务暂不可用。"}}"#)
    // 队列之后若还有第三次请求会落 404，这里恰好转述为「不应再有请求」。
    await store.retryFailed(taskID: taskID)
    XCTAssertEqual(retryRequests().count, 2, "第二题失败后停下，不再发更多请求")
    XCTAssertNotNil(store.errorMessage, "失败要给出错误")
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.revision, 2, "第一题的成功保留")
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.questions.first?.status, "ready")
  }

  // 进行中重复调用直接返回，不发第二个请求。
  func testRetryFailedWhileBusyIsIgnored() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", recoverable: true))
    let (store, _) = try makeStore(jobJSON: failed)
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let recovered = Self.jobJSON(revision: 2, status: "processing", phase: "inventory")
    LoopSyntheticProtocol.enqueueHold("POST", Self.retryPath, thenStatus: 202, thenBody: "{\"job\":" + recovered + "}")
    let first = Task { await store.retryFailed(taskID: taskID) }
    for _ in 0..<100 where LoopSyntheticProtocol.pendingCount == 0 {
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(LoopSyntheticProtocol.pendingCount, 1, "第一个请求已发出并被挂起")
    await store.retryFailed(taskID: taskID)
    XCTAssertEqual(retryRequests().count, 1, "进行中重复调用不发第二个请求")
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.revision, 2)
  }

  // 没有任何可恢复对象：不发请求、不报错。
  func testRetryFailedWithoutRecoverableTargetDoesNothing() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed",
      error: Self.failureJSON(stage: "questions", recoverable: false),
      questions: [
        Self.questionJSON(id: Self.q1, revision: 1, status: "failed",
          error: Self.failureJSON(stage: "transcribe", recoverable: false)),
      ])
    let (store, _) = try makeStore(jobJSON: failed)
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    await store.retryFailed(taskID: taskID)
    XCTAssertEqual(retryRequests().count, 0, "不可恢复的失败不发重试请求")
    XCTAssertNil(store.errorMessage)
  }

  // dismissPhoto：仅移出进度区——照片文件、识别任务、已进错题本的题都不动；持久化。
  func testDismissPhotoOnlyHidesAndPersists() async throws {
    let failed = Self.jobJSON(revision: 1, status: "failed", phase: "inventory",
      error: Self.failureJSON(stage: "inventory", recoverable: false))
    let (store, persistence) = try makeStore(jobJSON: failed)
    XCTAssertEqual(store.state.recognitionTasks.first?.dismissedFromProgress, nil)
    store.dismissPhoto(Self.photoName)
    let task = try XCTUnwrap(store.state.recognitionTasks.first)
    XCTAssertEqual(task.dismissedFromProgress, true)
    XCTAssertNotNil(task.job, "识别任务不动")
    XCTAssertTrue(FileManager.default.fileExists(atPath: store.photoURL(Self.photoName).path),
      "本机照片文件不动")
    let reloaded = StudyStore(persistence: persistence, client: nil)
    XCTAssertEqual(reloaded.state.recognitionTasks.first?.dismissedFromProgress, true,
      "移除标记持久化，重启后仍然不显示")
    XCTAssertNotNil(reloaded.state.recognitionTasks.first?.job)
  }

  // 旧存档无 dismissedFromProgress 键：解码为 nil（照常显示），不拒绝加载。
  func testOldArchiveWithoutDismissedFieldDecodesNil() throws {
    let oldJSON = #"{"id":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","photoName":"00000000-0000-4000-8000-00000000000a.jpg","uploadName":"00000000-0000-4000-8000-00000000000a.jpg"}"#
    let decoded = try JSONDecoder().decode(LocalRecognitionTask.self, from: Data(oldJSON.utf8))
    XCTAssertNil(decoded.dismissedFromProgress, "旧存档解码为 nil（未移除）")
    var task = decoded
    task.dismissedFromProgress = true
    let roundTrip = try JSONDecoder().decode(LocalRecognitionTask.self, from: JSONEncoder().encode(task))
    XCTAssertEqual(roundTrip.dismissedFromProgress, true)
  }
}
