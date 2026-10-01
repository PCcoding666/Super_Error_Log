import XCTest
import Foundation
@testable import StudentCore

// T6c RED：T6b 审查小修——updateClient / clearError / 接受与直改防连点 /
// 打印三种失败统一为 failed / cropFileURL 失败不写 lastError / 修改重试标记。
@MainActor final class LoopStoreReviewFixesTests: XCTestCase {
  static let itemID = "itm_0a1b2c3d4e5f6071"
  static let packetID = "pkt_1a2b3c4d5e6f7081"
  static let proposalID = "crp_a1b2c3d4e5f60718"

  override func setUp() { LoopSyntheticProtocol.reset() }

  private func makeStore(client: Bool = true, directory: URL? = nil,
    pollInterval: Duration = .milliseconds(5), pollTimeout: Duration = .seconds(1)) throws -> LoopStore {
    let directory = directory ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("LoopStoreFix-" + UUID().uuidString)
    guard client else {
      return LoopStore(client: nil, cacheDirectory: directory,
        pollInterval: pollInterval, pollTimeout: pollTimeout)
    }
    return LoopStore(client: try Self.makeClient(), cacheDirectory: directory,
      pollInterval: pollInterval, pollTimeout: pollTimeout)
  }

  private static func makeClient() throws -> V2Client {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3197", token: "loop-fix-synthetic-token")
    return V2Client(configuration: pairing, sessionConfiguration: configuration)
  }

  private func waitUntil(_ predicate: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<200 {
      if predicate() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("未等到预期状态", file: file, line: line)
  }

  private func primeEvidence(revision: Int = 1) {
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/evidence",
      body: #"{"questionText":"已知 x+y=1，求 x 的值。","subject":"数学","knowledgeTags":["一元一次方程"],"observations":[{"id":"o1","kind":"student_work","text":"x=1"}],"badge":"ok","revision":\#(revision)}"#)
  }

  private func primeProposal() {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct",
      body: #"{"proposalId":"crp_a1b2c3d4e5f60718","revision":1,"changes":[{"field":"questionText","before":"已知 x+y=1，求 x 的值。","after":"已知 x+y=1，求 y 的值。","find":"x 的值","replace":"y 的值"}],"clarify":null}"#)
  }

  // MARK: - 1. updateClient

  // 换成 nil：已显示的数据保留并标为缓存；之后刷新不发请求。
  func testUpdateClientToNilKeepsDataMarksCacheAndStopsRequests() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let store = try makeStore()
    await store.refreshWeek()
    XCTAssertEqual(store.week?.week, "2026-W40")
    XCTAssertFalse(store.isShowingCache)
    store.updateClient(nil)
    XCTAssertEqual(store.week?.week, "2026-W40", "已显示的数据保留")
    XCTAssertTrue(store.isShowingCache, "标为缓存直到下一次刷新成功")
    await store.refreshWeek()
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/week").count, 1,
      "无客户端不发请求")
  }

  // 换成新客户端：刷新走新客户端，成功后不再是缓存显示。
  func testUpdateClientToNewClientRefreshesThroughIt() async throws {
    let store = try makeStore()
    store.updateClient(try Self.makeClient())
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    await store.refreshWeek()
    XCTAssertEqual(store.week?.week, "2026-W40")
    XCTAssertFalse(store.isShowingCache)
  }

  // 换客户端：取消进行中的打印轮询、清掉复盘/修改/打印的进行中状态。
  func testUpdateClientCancelsPrintPollingAndClearsInProgress() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueueHold("GET", "/v2/practice/\(Self.packetID)/print",
      thenBody: #"{"status":"preparing","progress":{"done":1,"total":3}}"#)
    primeEvidence()
    primeProposal()
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .keyboard)
    XCTAssertNotNil(store.proposal)
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyPrint)
    store.updateClient(nil)
    XCTAssertEqual(store.printPhase, .none, "打印进行中状态清除")
    XCTAssertFalse(store.isBusyPrint)
    XCTAssertNil(store.evidence, "修改的进行中状态清除")
    XCTAssertNil(store.proposal)
    XCTAssertEqual(store.reflectionPhase, .idle)
    LoopSyntheticProtocol.releaseHeld()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)/print").count, 1,
      "换客户端后旧轮询不再发请求")
    XCTAssertEqual(store.printPhase, .none, "迟到的旧响应不得复活打印状态")
  }

  // 换客户端后，迟到旧响应不得复活复盘状态机。
  func testUpdateClientPreventsLateReflectionWriteback() async throws {
    LoopSyntheticProtocol.enqueueHold("POST", "/v2/items/\(Self.itemID)/reflection/ask",
      thenBody: #"{"turn":1,"question":"你当时是怎么想的？","source":"ai"}"#)
    let store = try makeStore()
    let first = Task { await store.startReflection(itemID: Self.itemID) }
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyReflection)
    store.updateClient(nil)
    XCTAssertEqual(store.reflectionPhase, .idle)
    XCTAssertFalse(store.isBusyReflection)
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(store.reflectionPhase, .idle, "旧客户端的迟到响应不得复活复盘状态")
  }

  // MARK: - 2. clearError

  func testClearErrorClearsLastError() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/discard", status: 409,
      body: #"{"error":{"code":"conflict","message":"当前状态不能标记为“不是错题”。"}}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.discard(itemID: Self.itemID)
    XCTAssertNotNil(store.lastError)
    store.clearError()
    XCTAssertNil(store.lastError)
  }

  // MARK: - 3. 接受 / 直改防连点

  func testBusyAcceptIgnoresSecondCall() async throws {
    primeEvidence()
    primeProposal()
    LoopSyntheticProtocol.enqueueHold("POST", "/v2/items/\(Self.itemID)/correct/accept",
      thenBody: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 y 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .keyboard)
    let first = Task { await store.acceptProposal() }
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyApply)
    await store.acceptProposal()
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/items/\(Self.itemID)/correct/accept").count, 1,
      "进行中重复调用不发第二个请求")
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    XCTAssertFalse(store.isBusyApply)
  }

  func testBusyApplyDirectIgnoresSecondCall() async throws {
    primeEvidence()
    LoopSyntheticProtocol.enqueueHold("POST", "/v2/items/\(Self.itemID)/correct/direct",
      thenBody: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"物理","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    let change = V2CorrectionChange(field: .subject, observationId: nil, before: "数学", after: "物理", find: nil, replace: nil)
    let first = Task { await store.applyDirect(changes: [change]) }
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyApply)
    await store.applyDirect(changes: [change])
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/items/\(Self.itemID)/correct/direct").count, 1,
      "进行中重复调用不发第二个请求")
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    XCTAssertFalse(store.isBusyApply)
  }

  // MARK: - 4. 打印三种失败统一为 failed

  // 轮询时网络失败：进入 failed，唯一重试路径是再调 requestPrint。
  func testPrintPollingNetworkFailureMarksFailed() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueueTransportFailure("GET", "/v2/practice/\(Self.packetID)/print", code: .notConnectedToInternet)
    let store = try makeStore()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .failed = store.printPhase { return true }; return false }
    XCTAssertEqual(store.printPhase,
      .failed("暂时连不上识别服务。已保存的照片和结果仍可查看，请检查连接后重试。（-1009）"))
    XCTAssertFalse(store.isBusyPrint)
  }

  // ready 后图片没下全：进入 failed，不停在 preparing。
  func testPrintMediaDownloadFailureMarksFailed() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"ready","snapshot":\#(LoopStoreTests.snapshotWithMediaJSON)}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/print/media/p0-crop.jpg", status: 404,
      body: #"{"error":{"code":"not_found","message":"快照图片不存在。"}}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/print/media/p0-diagram.jpg", status: 404,
      body: #"{"error":{"code":"not_found","message":"快照图片不存在。"}}"#)
    let store = try makeStore()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .failed = store.printPhase { return true }; return false }
    XCTAssertEqual(store.printPhase, .failed("打印图片没有全部下载成功，请再试一次。"))
    XCTAssertFalse(store.isBusyPrint)
  }

  // MARK: - 5. cropFileURL 失败不写 lastError

  func testCropFailureReturnsNilWithoutTouchingLastError() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/crop", status: 404,
      body: #"{"error":{"code":"not_found","message":"整题裁图无法读取。"}}"#)
    let store = try makeStore()
    let url = await store.cropFileURL(itemID: Self.itemID)
    XCTAssertNil(url)
    XCTAssertNil(store.lastError, "缩略图取不到不得顶掉真正的错误提示")
  }

  // MARK: - 7. 上次修改失败是否连接失败（没有收到服务器回应）

  func testProposalConnectionFailureMarkedRetryable() async throws {
    primeEvidence()
    LoopSyntheticProtocol.enqueueTransportFailure("POST", "/v2/items/\(Self.itemID)/correct", code: .notConnectedToInternet)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertNil(store.proposal)
    XCTAssertTrue(store.proposalRetryable, "连接失败（没有收到服务器回应）可原样重试")
  }

  func testProposalServerFailureNotRetryable() async throws {
    primeEvidence()
    LoopSyntheticProtocol.enqueue("POST", "/v2/items/\(Self.itemID)/correct", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"这次没生成出可用的修改，请换个说法或用键盘直接改"}}"#)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertNil(store.proposal)
    XCTAssertFalse(store.proposalRetryable, "收到了服务器回应（502）：不算连接失败，重试要换新请求标识")
    XCTAssertEqual(store.lastError, "这次没生成出可用的修改，请换个说法或用键盘直接改")
  }

  func testProposalSuccessClearsRetryable() async throws {
    primeEvidence()
    LoopSyntheticProtocol.enqueueTransportFailure("POST", "/v2/items/\(Self.itemID)/correct", code: .notConnectedToInternet)
    primeProposal()
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertTrue(store.proposalRetryable)
    await store.retryProposal()
    XCTAssertEqual(store.proposal?.proposalId, Self.proposalID)
    XCTAssertFalse(store.proposalRetryable, "成功后标记清除")
  }
}
