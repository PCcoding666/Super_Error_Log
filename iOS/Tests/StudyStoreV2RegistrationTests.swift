import XCTest
import Foundation
@testable import StudentCore

// T6b RED: 上传后登记（POST /v2/photos/:jobId/register）。合成传输同时服务 /v1 与 /v2，不连真实服务。
@MainActor final class StudyStoreV2RegistrationTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let questionMediaID = "1800c1bc-47ab-42bc-a46d-315005bdc695"
  static let photoName = "00000000-0000-4000-8000-000000000001.jpg"
  static let registerPath = "/v2/photos/3f7b69dc-9d37-4aaa-b965-bb61243445a0/register"
  static let registrationJSON = #"{"jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","registeredAt":"2026-09-30T08:15:00.123Z"}"#

  override func setUp() { LoopSyntheticProtocol.reset() }

  private func registerRequests() -> [URLRequest] {
    LoopSyntheticProtocol.requests(method: "POST", path: Self.registerPath)
  }

  private func serveV1() {
    LoopSyntheticProtocol.respond("POST", "/v1/recognitions", body: "{\"job\":" + RecognitionTests.fixture + "}")
    LoopSyntheticProtocol.respond("GET", "/v1/recognitions/\(Self.jobID)", body: "{\"job\":" + RecognitionTests.fixture + "}")
    LoopSyntheticProtocol.respond("GET", "/v1/recognitions/\(Self.jobID)/media/\(Self.questionMediaID)",
      body: StoreHTTPProtocol.jpeg, contentType: "image/jpeg")
  }

  private func makeStore(existingJob: Bool = false, v2Registered: Bool? = nil) throws -> StudyStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("V2Registration-" + UUID().uuidString)
    let persistence = StudyPersistence(directory: directory)
    try persistence.prepareDirectory()
    var state = StudyState()
    state.importedPhotos = [Self.photoName]
    if existingJob {
      let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(RecognitionTests.fixture.utf8))
      try state.ingest(job, photoName: Self.photoName)
      state.recognitionTasks[0].v2Registered = v2Registered
    }
    try persistence.save(state)
    let photos = directory.appendingPathComponent("Photos")
    try FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
    try StoreHTTPProtocol.jpeg.write(to: photos.appendingPathComponent(Self.photoName))
    let sessionConfiguration = URLSessionConfiguration.ephemeral
    sessionConfiguration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3198", token: "synthetic-register")
    return StudyStore(
      persistence: persistence,
      client: RecognitionClient(configuration: pairing, sessionConfiguration: sessionConfiguration),
      v2Client: V2Client(configuration: pairing, sessionConfiguration: sessionConfiguration))
  }

  // 上传成功拿到任务后立即登记；登记成功置 v2Registered = true。
  func testUploadRegistersImmediatelyAndMarksTask() async throws {
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, body: Self.registrationJSON)
    let store = try makeStore()
    await store.submitPhotos([Self.photoName])
    let task = try XCTUnwrap(store.state.recognitionTasks.first)
    XCTAssertNotNil(task.job, "上传行为不变：任务已登记在本机")
    XCTAssertEqual(task.v2Registered, true)
    XCTAssertEqual(registerRequests().count, 1)
    XCTAssertNil(store.errorMessage)
  }

  // 服务器 404（任务不存在）：记 false 并保留，不再重试；不影响上传结果、不弹错误。
  func testUploadRegisterNotFoundMarksFalseAndNeverRetries() async throws {
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, status: 404,
      body: #"{"error":{"code":"not_found","message":"识别任务不存在。"}}"#)
    let store = try makeStore()
    await store.submitPhotos([Self.photoName])
    let task = try XCTUnwrap(store.state.recognitionTasks.first)
    XCTAssertNotNil(task.job, "登记失败不影响上传结果")
    XCTAssertEqual(task.v2Registered, false)
    XCTAssertNil(store.errorMessage, "登记失败不弹错误")
    await store.refreshJobs()
    await store.refreshJobs()
    XCTAssertEqual(registerRequests().count, 1, "404 之后不再重试该任务")
    XCTAssertEqual(store.state.recognitionTasks.first?.v2Registered, false)
  }

  // 登记暂时失败（500）：不弹错误，v2Registered 保持 nil，refreshJobs 补登记直到成功。
  func testUploadRegisterFailureIsBackfilledOnRefresh() async throws {
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, status: 500,
      body: #"{"error":{"code":"invalid_request","message":"服务暂不可用。"}}"#)
    let store = try makeStore()
    await store.submitPhotos([Self.photoName])
    XCTAssertNil(store.state.recognitionTasks.first?.v2Registered)
    XCTAssertNotNil(store.state.recognitionTasks.first?.job)
    XCTAssertNil(store.errorMessage)
    LoopSyntheticProtocol.reset()
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, body: Self.registrationJSON)
    await store.refreshJobs()
    XCTAssertEqual(registerRequests().count, 1, "refreshJobs 对未登记任务补登记")
    XCTAssertEqual(store.state.recognitionTasks.first?.v2Registered, true)
  }

  // 已有任务、v2Registered == nil：refreshJobs 补登记。
  func testRefreshJobsBackfillsUnregisteredTask() async throws {
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, body: Self.registrationJSON)
    let store = try makeStore(existingJob: true)
    XCTAssertNil(store.state.recognitionTasks.first?.v2Registered)
    await store.refreshJobs()
    XCTAssertEqual(registerRequests().count, 1)
    XCTAssertEqual(store.state.recognitionTasks.first?.v2Registered, true)
    XCTAssertNil(store.state.recognitionTasks.first?.lastIssueKind, "登记与识别刷新互不影响")
  }

  // 已登记任务：refreshJobs 不再发登记请求，识别刷新照常。
  func testRefreshJobsSkipsAlreadyRegisteredTask() async throws {
    serveV1()
    LoopSyntheticProtocol.respond("POST", Self.registerPath, body: Self.registrationJSON)
    let store = try makeStore(existingJob: true, v2Registered: true)
    await store.refreshJobs()
    XCTAssertEqual(registerRequests().count, 0)
    XCTAssertFalse(LoopSyntheticProtocol.requests(method: "GET", path: "/v1/recognitions/\(Self.jobID)").isEmpty,
      "识别进度刷新行为不变")
  }

  // 旧存档无 v2Registered 键：解码为 nil；编码兼容（置回后往返一致）。
  func testV2RegisteredDecodesNilFromOldArchiveAndRoundTrips() throws {
    let oldJSON = #"{"id":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","photoName":"00000000-0000-4000-8000-000000000001.jpg","uploadName":"00000000-0000-4000-8000-000000000001.jpg"}"#
    let decoded = try JSONDecoder().decode(LocalRecognitionTask.self, from: Data(oldJSON.utf8))
    XCTAssertNil(decoded.v2Registered, "旧存档解码为 nil")
    var task = decoded
    task.v2Registered = true
    let reencoded = try JSONEncoder().encode(task)
    let again = try JSONDecoder().decode(LocalRecognitionTask.self, from: reencoded)
    XCTAssertEqual(again.v2Registered, true)
    task.v2Registered = false
    let againFalse = try JSONDecoder().decode(LocalRecognitionTask.self, from: JSONEncoder().encode(task))
    XCTAssertEqual(againFalse.v2Registered, false)
  }
}
