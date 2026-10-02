import XCTest
import Foundation
@testable import StudentCore

// S2 RED：勾选错题（POST /v1/recognitions/:id/select）与候选题缩略图。
// 合成传输（LoopSyntheticProtocol），不连真实服务。
@MainActor final class StudyStoreSelectTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let mediaID = "6ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static let photoName = "00000000-0000-4000-8000-00000000000c.jpg"
  static let q1 = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let q2 = "aa16756c-44cc-4a1f-a2dc-93605cbd0b31"
  static let q3 = "1800c1bc-47ab-42bc-a46d-315005bdc695"
  static let selectPath = "/v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/select"
  static let candidatePath = "/v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/questions/a42b4eb2-12ff-499f-92de-e49d7cb36ef7/candidate"

  override func setUp() { LoopSyntheticProtocol.reset() }

  private static func questionJSON(id: String, number: String, revision: Int, status: String,
    selectedByStudent: Bool? = nil) -> String {
    let selected = selectedByStudent.map { #","selectedByStudent":\#($0)"# } ?? ""
    return #"{"id":"\#(id)","number":"\#(number)","revision":\#(revision),"status":"\#(status)","selectionEvidence":"unmarked","evidence":null,"verification":null,"questionMediaId":null,"diagramMediaIds":[],"error":null,"confirmedAt":null\#(selected)}"#
  }

  private static func jobJSON(revision: Int, status: String, phase: String = "complete",
    questions: [String]) -> String {
    #"{"version":1,"id":"\#(jobID)","revision":\#(revision),"photoName":"\#(photoName)","sourceHash":"abc","sourceMediaId":"\#(mediaID)","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[\#(questions.joined(separator: ","))],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  /// 无痕迹照片：找题完成、3 道全部 unselected 的任务已在本机。
  private func makeStore() throws -> (StudyStore, StudyPersistence) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("Select-" + UUID().uuidString)
    let persistence = StudyPersistence(directory: directory)
    try persistence.prepareDirectory()
    var state = StudyState()
    state.importedPhotos = [Self.photoName]
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self,
      from: Data(Self.jobJSON(revision: 2, status: "completed", questions: [
        Self.questionJSON(id: Self.q1, number: "1", revision: 1, status: "unselected"),
        Self.questionJSON(id: Self.q2, number: "2", revision: 1, status: "unselected"),
        Self.questionJSON(id: Self.q3, number: "3", revision: 1, status: "unselected"),
      ]).utf8))
    try state.ingest(job, photoName: Self.photoName)
    try persistence.save(state)
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3198", token: "synthetic-select")
    let store = StudyStore(
      persistence: persistence,
      client: RecognitionClient(configuration: pairing, sessionConfiguration: sessionConfiguration))
    return (store, persistence)
  }

  private func selectRequests() -> [URLRequest] {
    LoopSyntheticProtocol.requests(method: "POST", path: Self.selectPath)
  }

  private func questionIDsSent(_ request: URLRequest) -> [String]? {
    guard let body = request.httpBody,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
    return object["questionIds"] as? [String]
  }

  // 成功：POST 正文 {"questionIds":[…]}；返回的任务更新本机、置 pickDone、恢复轮询、返回 true。
  func testSelectSuccessUpdatesTaskMarksPickDoneAndReturnsTrue() async throws {
    let (store, persistence) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let accepted = Self.jobJSON(revision: 3, status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, number: "1", revision: 1, status: "unselected"),
      Self.questionJSON(id: Self.q2, number: "2", revision: 2, status: "queued", selectedByStudent: true),
      Self.questionJSON(id: Self.q3, number: "3", revision: 2, status: "queued", selectedByStudent: true),
    ])
    LoopSyntheticProtocol.respond("POST", Self.selectPath, body: "{\"job\":" + accepted + "}")
    let ok = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2, Self.q3])
    XCTAssertTrue(ok)
    XCTAssertEqual(selectRequests().count, 1)
    XCTAssertEqual(questionIDsSent(try XCTUnwrap(selectRequests().first)), [Self.q2, Self.q3])
    let task = try XCTUnwrap(store.state.recognitionTasks.first)
    XCTAssertEqual(task.job?.revision, 3, "用返回的任务更新本机")
    XCTAssertEqual(task.job?.questions[1].status, "queued")
    XCTAssertEqual(task.job?.questions[1].selectedByStudent, true)
    XCTAssertEqual(task.pickDone, true, "成功后置 pickDone")
    XCTAssertNil(store.errorMessage)
    // 持久化：重启后 pickDone 仍在。
    let reloaded = StudyStore(persistence: persistence, client: nil)
    XCTAssertEqual(reloaded.state.recognitionTasks.first?.pickDone, true)
  }

  // 409（还在找题）：学生能看懂的一句，返回 false，本机任务不动。
  func testSelectConflictGivesReadableSentence() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    LoopSyntheticProtocol.respond("POST", Self.selectPath, status: 409,
      body: #"{"error":{"code":"not_selectable","message":"job is still in inventory"}}"#)
    let ok = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2])
    XCTAssertFalse(ok)
    XCTAssertEqual(store.errorMessage, "这张照片还在找题，稍后再选")
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.revision, 2)
    XCTAssertNil(store.state.recognitionTasks.first?.pickDone)
  }

  // 429（队列满）：学生能看懂的一句。
  func testSelectCapacityFullGivesReadableSentence() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    LoopSyntheticProtocol.respond("POST", Self.selectPath, status: 429,
      body: #"{"error":{"code":"capacity_full","message":"queue full"}}"#)
    let ok = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2])
    XCTAssertFalse(ok)
    XCTAssertEqual(store.errorMessage, "排队的题太多了，过一会儿再选")
  }

  // 离线：沿用现有离线提示。
  func testSelectOfflineKeepsExistingOfflineMessage() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    LoopSyntheticProtocol.enqueueTransportFailure("POST", Self.selectPath, code: .notConnectedToInternet)
    let ok = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2])
    XCTAssertFalse(ok)
    XCTAssertTrue(store.errorMessage?.contains("暂时连不上识别服务") == true,
      "离线沿用现有提示，实得：\(store.errorMessage ?? "nil")")
  }

  // 进行中重复调用直接返回，不发第二个请求。
  func testSelectWhileBusyIsIgnored() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let accepted = Self.jobJSON(revision: 3, status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, number: "1", revision: 1, status: "unselected"),
      Self.questionJSON(id: Self.q2, number: "2", revision: 2, status: "queued", selectedByStudent: true),
      Self.questionJSON(id: Self.q3, number: "3", revision: 1, status: "unselected"),
    ])
    LoopSyntheticProtocol.enqueueHold("POST", Self.selectPath, thenStatus: 200, thenBody: "{\"job\":" + accepted + "}")
    let first = Task { await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2]) }
    for _ in 0..<100 where LoopSyntheticProtocol.pendingCount == 0 {
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(LoopSyntheticProtocol.pendingCount, 1, "第一个请求已发出并被挂起")
    let second = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q3])
    XCTAssertFalse(second, "进行中重复调用直接返回")
    XCTAssertEqual(selectRequests().count, 1)
    LoopSyntheticProtocol.releaseHeld()
    let firstResult = await first.value
    XCTAssertTrue(firstResult)
  }

  // markPickDone：只置标记（「这页没有错题」），持久化。
  func testMarkPickDoneSetsFlagAndPersists() async throws {
    let (store, persistence) = try makeStore()
    XCTAssertNil(store.state.recognitionTasks.first?.pickDone)
    store.markPickDone(Self.photoName)
    XCTAssertEqual(store.state.recognitionTasks.first?.pickDone, true)
    XCTAssertEqual(selectRequests().count, 0, "不发任何请求")
    let reloaded = StudyStore(persistence: persistence, client: nil)
    XCTAssertEqual(reloaded.state.recognitionTasks.first?.pickDone, true)
  }

  // 已登记过的照片第二次到终态：勾入的题读完后任务再次 completed，
  // 本机任务状态随刷新推进（主页周视图刷新依赖这一终态转移）。
  func testSecondTerminalAfterSelectRefreshesTaskToCompleted() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    let accepted = Self.jobJSON(revision: 3, status: "processing", phase: "questions", questions: [
      Self.questionJSON(id: Self.q1, number: "1", revision: 1, status: "unselected"),
      Self.questionJSON(id: Self.q2, number: "2", revision: 2, status: "queued", selectedByStudent: true),
      Self.questionJSON(id: Self.q3, number: "3", revision: 2, status: "queued", selectedByStudent: true),
    ])
    LoopSyntheticProtocol.respond("POST", Self.selectPath, body: "{\"job\":" + accepted + "}")
    let selected = await store.selectQuestions(taskID: taskID, questionIDs: [Self.q2, Self.q3])
    XCTAssertTrue(selected)
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.status, "processing",
      "勾选后任务回到进行中（终态计数回落，主页才能再次看到上升沿）")
    let done = Self.jobJSON(revision: 4, status: "completed", questions: [
      Self.questionJSON(id: Self.q1, number: "1", revision: 1, status: "unselected"),
      Self.questionJSON(id: Self.q2, number: "2", revision: 3, status: "confirmed", selectedByStudent: true),
      Self.questionJSON(id: Self.q3, number: "3", revision: 3, status: "confirmed", selectedByStudent: true),
    ])
    LoopSyntheticProtocol.respond("GET", "/v1/recognitions/\(Self.jobID)", body: "{\"job\":" + done + "}")
    await store.refreshJobs()
    XCTAssertEqual(store.state.recognitionTasks.first?.job?.status, "completed",
      "第二次到终态：本机任务再次 completed，触发主页周视图刷新")
  }

  // 候选题缩略图：GET …/questions/:questionId/candidate 返回 JPEG 数据。
  func testCandidateImageFetchesJPEG() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    LoopSyntheticProtocol.respond("GET", Self.candidatePath,
      body: StoreHTTPProtocol.jpeg, contentType: "image/jpeg")
    let data = await store.candidateImage(taskID: taskID, questionID: Self.q1)
    XCTAssertEqual(data, StoreHTTPProtocol.jpeg)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: Self.candidatePath).count, 1)
  }

  // 候选题缩略图取不到（404/非 JPEG）：返回 nil，不弹错误。
  func testCandidateImageFailureReturnsNilSilently() async throws {
    let (store, _) = try makeStore()
    let taskID = try XCTUnwrap(store.state.recognitionTasks.first?.id)
    LoopSyntheticProtocol.respond("GET", Self.candidatePath, status: 404,
      body: #"{"error":{"code":"not_found","message":"题目不存在。"}}"#)
    let data = await store.candidateImage(taskID: taskID, questionID: Self.q1)
    XCTAssertNil(data)
    XCTAssertNil(store.errorMessage)
  }
}
