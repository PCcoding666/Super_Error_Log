import XCTest
import Foundation
@testable import StudentCore

// 「换了网络连不上」：连接失败（.failed）时，重试仍然只是重查；只有明确的重新扫码才清掉配对。
// 真实 StudyStore + 真实钥匙串写入（一次性的 UITest-<UUID> 集合名，用完即删），
// 只在 HTTP 传输处拦截（URLProtocol 合成）；不连任何服务，不调用模型。
@MainActor
final class StudyStoreRescanTests: XCTestCase {
  private static let cloudURL = "https://study.pccoding666.com"
  private static let serviceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"

  private struct Fixture {
    let store: StudyStore
    let scope: String
    let configuration: PairingConfiguration
  }

  /// 已保存云配对（钥匙串）+ 云端客户端的 store，健康检查按 `mode` 的方式失败。
  private func makeStore(mode: RescanHealthProtocol.Mode) throws -> Fixture {
    RescanHealthProtocol.reset(mode: mode)
    let parent = FileManager.default.temporaryDirectory
      .appendingPathComponent("RescanTests-" + UUID().uuidString, isDirectory: true)
    // 钥匙串账号只接受 StudentExperience 或 UITest-<UUID>：用后者，绝不碰真实学生集合。
    let directory = parent.appendingPathComponent("UITest-" + UUID().uuidString, isDirectory: true)
    let persistence = StudyPersistence(directory: directory)
    try persistence.prepareDirectory()
    let scope = directory.lastPathComponent
    let configuration = try PairingConfiguration.cloud(
      baseURL: Self.cloudURL, serviceId: Self.serviceId,
      token: "synthetic-device-token-32-bytes-test!",
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb", expiresAt: nil)
    try PairingStore.save(configuration, scope: scope)
    addTeardownBlock {
      PairingStore.remove(scope: scope)
      try? FileManager.default.removeItem(at: parent)
    }
    let session = URLSessionConfiguration.ephemeral
    session.protocolClasses = [RescanHealthProtocol.self]
    let client = RecognitionClient(configuration: configuration, sessionConfiguration: session)
    // /v2 客户端用默认的临时会话（本测试不发 /v2 请求）：只为断言重新扫码会把它一起关掉、置空。
    let store = StudyStore(persistence: persistence, client: client, v2Client: V2Client(configuration: configuration))
    return Fixture(store: store, scope: scope, configuration: configuration)
  }

  func testRetryFromFailedOnlyRechecksAndKeepsThePairing() async throws {
    let fixture = try makeStore(mode: .unreachable)
    let store = fixture.store
    let first = await store.checkConnection(force: true)
    XCTAssertEqual(first, .failed, "服务器连不上（传输错误）是 .failed，不是授权失效")
    XCTAssertEqual(RescanHealthProtocol.healthRequestCount, 1)

    await store.connectionAction()

    XCTAssertEqual(RescanHealthProtocol.healthRequestCount, 2, "重试 = 再发一次健康检查")
    XCTAssertEqual(store.connectionState, .failed, "还是连不上，仍是 .failed")
    XCTAssertEqual(store.pairing, fixture.configuration, "重试不得动配对")
    XCTAssertNotNil(store.v2Client)
    XCTAssertEqual(try PairingStore.load(scope: fixture.scope), fixture.configuration, "重试不得删钥匙串里的配对")
  }

  func testRepairByRescanFromFailedClearsPairingAndEndsUnpaired() async throws {
    let fixture = try makeStore(mode: .unreachable)
    let store = fixture.store
    let failed = await store.checkConnection(force: true)
    XCTAssertEqual(failed, .failed)
    XCTAssertNotNil(try PairingStore.load(scope: fixture.scope))
    let requestsBefore = RescanHealthProtocol.healthRequestCount

    store.repairByRescan()

    XCTAssertEqual(store.connectionState, .unpaired)
    XCTAssertNil(store.pairing)
    XCTAssertNil(store.v2Client)
    XCTAssertNil(try PairingStore.load(scope: fixture.scope), "配对必须从钥匙串里删掉")
    XCTAssertEqual(RescanHealthProtocol.healthRequestCount, requestsBefore, "重新扫码本身不发任何网络请求")
    // 没有客户端了：再重查什么都不发，状态仍是未配对（等扫码页给出新配对）。
    let after = await store.checkConnection(force: true)
    XCTAssertNil(after)
    XCTAssertEqual(store.connectionState, .unpaired)
    XCTAssertEqual(RescanHealthProtocol.healthRequestCount, requestsBefore)
  }

  func testLateFailureFromBeforeRescanCannotOverwriteUnpaired() async throws {
    let fixture = try makeStore(mode: .hold)
    let store = fixture.store
    let check = Task { await store.checkConnection(force: true) }
    // 等健康检查真的挂在传输上（在途）。
    for _ in 0..<200 where RescanHealthProtocol.pendingCount == 0 { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(RescanHealthProtocol.pendingCount, 1)
    XCTAssertEqual(store.connectionState, .checking)

    store.repairByRescan()
    RescanHealthProtocol.releaseWithFailure()
    _ = await check.value

    XCTAssertEqual(store.connectionState, .unpaired, "重新扫码之前发出的检查迟到失败，不能把状态改回 .failed")
    XCTAssertNil(store.pairing)
  }

  func testConnectionActionStillClearsPairingWhenUnauthorized() async throws {
    // connectionAction 的授权失效分支现在委托给 repairByRescan：行为必须不变。
    let fixture = try makeStore(mode: .unauthorized)
    let store = fixture.store
    let state = await store.checkConnection(force: true)
    XCTAssertEqual(state, .unauthorized)

    await store.connectionAction()

    XCTAssertEqual(store.connectionState, .unpaired)
    XCTAssertNil(store.pairing)
    XCTAssertNil(try PairingStore.load(scope: fixture.scope))
  }
}

/// 健康检查的合成传输：`.unreachable` 模拟 TLS 被重置（传输错误，没有 HTTP 响应）；
/// `.unauthorized` 回 401；`.hold` 挂住请求直到 `releaseWithFailure()`。
final class RescanHealthProtocol: URLProtocol, @unchecked Sendable {
  enum Mode { case unreachable, unauthorized, hold }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var mode = Mode.unreachable
  nonisolated(unsafe) private static var requestCount = 0
  nonisolated(unsafe) private static var pending: [RescanHealthProtocol] = []

  static func reset(mode: Mode) { lock.withLock { Self.mode = mode; requestCount = 0; pending = [] } }
  static var healthRequestCount: Int { lock.withLock { requestCount } }
  static var pendingCount: Int { lock.withLock { pending.count } }
  static func releaseWithFailure() {
    let waiting = lock.withLock { let value = pending; pending = []; return value }
    for transport in waiting { transport.failTransport() }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let mode = Self.lock.withLock { () -> Mode in
      Self.requestCount += 1
      if Self.mode == .hold { Self.pending.append(self) }
      return Self.mode
    }
    switch mode {
    case .unreachable: failTransport()
    case .unauthorized:
      let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(#"{"error":{"code":"unauthorized","message":"设备令牌无效。"}}"#.utf8))
      client?.urlProtocolDidFinishLoading(self)
    case .hold: break
    }
  }
  fileprivate func failTransport() {
    client?.urlProtocol(self, didFailWithError: URLError(.secureConnectionFailed))
  }
  override func stopLoading() {}
}
