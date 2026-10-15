import XCTest
import Foundation
import CoreGraphics
import ImageIO
import Observation
@testable import StudentCore

// Real store + persistence + client, intercepted only at the HTTP transport boundary.
@MainActor final class StudyStoreRegressionTests: XCTestCase {
  static let diagramID = "2ddc034b-b0f8-4288-b9c1-4f496cfb90df"
  static var jobJSON: String {
    RecognitionTests.fixture.replacingOccurrences(of: "\"status\":\"confirmed\"", with: "\"status\":\"ready\"")
      .replacingOccurrences(of: "\"requiresDiagram\":false", with: "\"requiresDiagram\":true")
      .replacingOccurrences(of: "\"regions\":[]", with: #""regions":[{"id":"d1","kind":"diagram","box":{"x":0.1,"y":0.1,"width":0.2,"height":0.2},"confidence":0.8,"cleanForPrint":false}]"#)
      .replacingOccurrences(of: "\"diagramMediaIds\":[]", with: "\"diagramMediaIds\":[\"\(diagramID)\"]")
  }
  static var needsCheckJobJSON: String {
    jobJSON
      .replacingOccurrences(of: "\"status\":\"ready\"", with: "\"status\":\"needs_check\"")
      .replacingOccurrences(of: "\"uncertainties\":[]", with: "\"uncertainties\":[\"合成看不清\"]")
  }
  // 默认参数不能引用协变 Self（类成员）：改为可选参数在函数体内解析。
  func makeStore(count: Int = 1, existingJob: Bool = false, jobJSON: String? = nil) throws -> (StudyStore, [String], RecognitionJob) {
    let jobJSON = jobJSON ?? Self.jobJSON
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("StoreRegression-" + UUID().uuidString)
    let persistence = StudyPersistence(directory: directory)
    try persistence.prepareDirectory()
    var state = StudyState()
    let names = (0..<count).map { String(format: "00000000-0000-4000-8000-%012d.jpg", $0 + 1) }
    state.importedPhotos = names
    let job = try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(jobJSON.utf8))
    if existingJob { try state.ingest(job, photoName: names[0]) }
    try persistence.save(state)
    let photos = directory.appendingPathComponent("Photos")
    try FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
    for name in names { try StoreHTTPProtocol.jpeg.write(to: photos.appendingPathComponent(name)) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StoreHTTPProtocol.self]
    let client = RecognitionClient(configuration: try PairingConfiguration(baseURL: "http://127.0.0.1:3102", token: "synthetic-store-only"), sessionConfiguration: configuration)
    return (StudyStore(persistence: persistence, client: client), names, job)
  }

  func testElevenSelectedPhotosConsentAndHTTPKeepExactFirstTenInOrder() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .uploadFailure)
    let (store, names, _) = try makeStore(count: 11)
    // v2 主页一次最多发 10 张（相册选择器上限）；这里直接取前 10 张验证顺序与逐张上传。
    let consented = Array(names.prefix(10))
    await store.submitPhotos(consented)
    XCTAssertEqual(StoreHTTPProtocol.requests.map { $0.value(forHTTPHeaderField: "X-Photo-Name") }, Array(names[0...9]))
    XCTAssertEqual(store.state.recognitionTasks.map(\.photoName), consented)
    XCTAssertNil(store.state.recognitionTasks.first { $0.photoName == names[10] })
  }

  func testOversizedDirectSubmissionIsExplainedWithoutSilentlyDroppingNames() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .uploadFailure)
    let (store, names, _) = try makeStore(count: 11)
    await store.submitPhotos(names)
    XCTAssertEqual(StoreHTTPProtocol.requests.count, 0)
    XCTAssertNotNil(store.errorMessage)
    XCTAssertTrue(store.state.recognitionTasks.isEmpty)
  }

  func testMalformedDownloadedJPEGIsPreservedAndTaskReportsFailure() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .malformedMedia)
    let (store, _, _) = try makeStore(existingJob: true)
    await store.refreshJobs()
    let task = store.state.recognitionTasks[0]
    XCTAssertNotNil(task.lastError, "下载到损坏图示必须如实报错")
    let corrupt = try FileManager.default.contentsOfDirectory(at: store.persistence.directory.appendingPathComponent("CorruptMedia"), includingPropertiesForKeys: nil)
    XCTAssertTrue(try corrupt.contains { try Data(contentsOf: $0) == Data([0xff, 0xd8, 0xff, 0x00]) },
      "损坏字节保留在 CorruptMedia，不覆盖丢弃证据")
  }

  func testExistingCorruptCacheIsPreservedAndRefreshRepublishesReadableState() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .normal)
    let (store, _, job) = try makeStore(existingJob: true)
    let url = store.mediaURL(jobID: job.id, mediaID: Self.diagramID)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let corrupt = Data([0xff, 0xd8, 0xff, 0x00])
    try corrupt.write(to: url)
    let readableBefore = await MediaReadability.readableFile(url)
    XCTAssertFalse(readableBefore)
    await store.refreshJobs()
    let readableAfter = await MediaReadability.readableFile(url)
    XCTAssertTrue(readableAfter, "刷新后重新下载到可读图示")
    XCTAssertEqual(try Data(contentsOf: url), StoreHTTPProtocol.jpeg)
    let preserved = try FileManager.default.contentsOfDirectory(at: store.persistence.directory.appendingPathComponent("CorruptMedia"), includingPropertiesForKeys: nil)
    XCTAssertTrue(try preserved.contains { try Data(contentsOf: $0) == corrupt })
  }

  func testUploadCompletingInactiveCannotRestartPollingUntilActivation() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .holdUpload)
    let (store, names, _) = try makeStore()
    store.setActive(true)
    let submit = Task { await store.submitPhotos(names) }
    await waitUntil { StoreHTTPProtocol.pendingCount > 0 }
    store.setActive(false)
    StoreHTTPProtocol.release()
    await submit.value
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertNotNil(store.state.recognitionTasks.first?.job)
    XCTAssertFalse(StoreHTTPProtocol.requests.contains { $0.httpMethod == "GET" })
    store.setActive(true)
    await waitUntil { StoreHTTPProtocol.requests.contains { $0.httpMethod == "GET" } }
    XCTAssertTrue(StoreHTTPProtocol.requests.contains { $0.httpMethod == "GET" })
    store.setActive(false)
  }

  // M1：刷新失败分类为「服务暂不可用」，缓存任务与确认内容保留；恢复成功后清除标记。
  func testRefreshFailureClassifiesIssueKeepsCacheAndClearsOnRecovery() async throws {
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .uploadFailure)   // 500 on every request
    let (store, _, job) = try makeStore(existingJob: true)
    await store.refreshJobs()
    var task = store.state.recognitionTasks[0]
    XCTAssertEqual(task.lastIssueKind, .serviceUnavailable)
    XCTAssertEqual(task.job, job, "刷新失败不得丢弃已缓存任务")
    XCTAssertNotNil(task.lastError)
    StoreHTTPProtocol.reset(job: Self.jobJSON, mode: .normal)
    await store.refreshJobs()
    task = store.state.recognitionTasks[0]
    XCTAssertNil(task.lastIssueKind, "恢复成功后清除分类标记")
  }

  private func waitUntil(_ predicate: () -> Bool) async {
    for _ in 0..<100 {
      if predicate() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Synthetic transport did not reach expected boundary")
  }
}

final class StoreHTTPProtocol: URLProtocol, @unchecked Sendable {
  enum Mode { case normal, uploadFailure, malformedMedia, holdDiagram, holdUpload }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var captured: [URLRequest] = []
  nonisolated(unsafe) private static var pending: [StoreHTTPProtocol] = []
  nonisolated(unsafe) private static var mode = Mode.normal
  nonisolated(unsafe) private static var job = ""
  static var requests: [URLRequest] { lock.withLock { captured } }
  static var pendingCount: Int { lock.withLock { pending.count } }
  static let jpeg: Data = {
    let context = CGContext(data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    return data as Data
  }()
  static func reset(job: String, mode: Mode) { lock.withLock { captured = []; pending = []; Self.job = job; Self.mode = mode } }
  static func release() {
    let waiting = lock.withLock { let value = pending; pending = []; mode = .normal; return value }
    for transport in waiting { transport.respond() }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let held = Self.lock.withLock {
      Self.captured.append(request)
      if Self.mode == .holdUpload && request.httpMethod == "POST" || Self.mode == .holdDiagram && request.url!.path.hasSuffix("2ddc034b-b0f8-4288-b9c1-4f496cfb90df") {
        Self.pending.append(self); return true
      }
      return false
    }
    if !held { respond() }
  }
  private func respond() {
    let (mode, job) = Self.lock.withLock { (Self.mode, Self.job) }
    let media = request.url!.path.contains("/media/")
    let failure = mode == .uploadFailure
    let body = media ? (mode == .malformedMedia ? Data([0xff, 0xd8, 0xff, 0x00]) : Self.jpeg) : Data((failure ? "{}" : "{\"job\":" + job + "}").utf8)
    let response = HTTPURLResponse(url: request.url!, statusCode: failure ? 500 : 200, httpVersion: nil, headerFields: ["Content-Type": media ? "image/jpeg" : "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
