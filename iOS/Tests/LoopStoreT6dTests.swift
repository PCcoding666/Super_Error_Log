import XCTest
import Foundation
@testable import StudentCore

// T6d-w RED：LoopStore 新增能力——
// 1. skipFollowup()：等待回答时跳过追问，直接进入确认页（三项建议为空）。
// 2. 追问已结束（ask 409）恢复：读取复盘详情（§3.20），用最近一次 AI 建议进入确认页；
//    已有复盘记录时暴露给学生作「上次的选择」初始值。
// 3. submitReturn 保留最近一次提交的逐条结果（lastReturnResults），含成功条目的服务器文案。
// 4. summary 记录所属练习包（summaryPracticeID），并随离线缓存保存。
@MainActor final class LoopStoreT6dTests: XCTestCase {
  static let itemID = "itm_0a1b2c3d4e5f6071"
  static let itemID2 = "itm_1111111111111111"
  static let packetID = "pkt_1a2b3c4d5e6f7081"
  static let packetID2 = "pkt_2222222222222222"

  override func setUp() { LoopSyntheticProtocol.reset() }

  private func makeStore(client: Bool = true, directory: URL? = nil) throws -> LoopStore {
    let directory = directory ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("LoopStoreT6d-" + UUID().uuidString)
    guard client else { return LoopStore(client: nil, cacheDirectory: directory) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3198", token: "loop-t6d-synthetic-token")
    return LoopStore(client: V2Client(configuration: pairing, sessionConfiguration: configuration),
      cacheDirectory: directory)
  }

  private func primeAsk(question: String = "你原来写 x=1，这一步当时是怎么想的？") {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask",
      body: #"{"turn":1,"question":"\#(question)","source":"ai"}"#)
  }

  // MARK: - 1. skipFollowup

  func testSkipFollowupFromWaitingAnswerEntersConfirmingWithEmptySuggestions() async throws {
    primeAsk()
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    guard case .waitingAnswer = store.reflectionPhase else { return XCTFail("应在等待回答") }
    store.skipFollowup()
    XCTAssertEqual(store.reflectionPhase, .confirming(summary: nil, suggestedCause: nil, suggestedAttemptState: nil),
      "跳过追问直接进入确认页，三项建议为空")
    XCTAssertFalse(store.isBusyReflection, "跳过不调用模型、不置忙")
  }

  func testSkipFollowupIgnoredOutsideWaitingAnswer() async throws {
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    let store = try makeStore()
    store.skipFollowup()
    XCTAssertEqual(store.reflectionPhase, .idle, "idle 时跳过无效")
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    guard case .confirming = store.reflectionPhase else { return XCTFail("应已进入确认") }
    store.skipFollowup()
    XCTAssertEqual(store.reflectionPhase,
      .confirming(summary: "把移项当成了照抄，漏了变号", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错"),
      "已在确认页时跳过不得清空 AI 建议")
  }

  // MARK: - 2. 追问已结束（ask 409）恢复

  private static let askEnded409 = #"{"error":{"code":"conflict","message":"追问已结束（最多两轮），请提交复盘。"}}"#

  func testAskEnded409EntersConfirmingWithLatestSuggestion() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask", status: 409, body: Self.askEnded409)
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"turns":[{"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai","answer":"我以为移项不用变号"}],"suggestion":{"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错"},"reflection":null}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    XCTAssertEqual(store.reflectionPhase,
      .confirming(summary: "把移项当成了照抄，漏了变号", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错"),
      "追问已结束时不报错停住，用最近一次 AI 建议进入确认页")
    XCTAssertNil(store.lastError)
    XCTAssertNil(store.reflectionPreviousRecord, "没有复盘记录时不提供「上次的选择」")
    XCTAssertFalse(store.isBusyReflection)
  }

  func testAskEnded409WithExistingReflectionExposesPreviousRecord() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask", status: 409, body: Self.askEnded409)
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"turns":[],"suggestion":{"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错"},"reflection":{"id":"dia_9f8e7d6c5b4a3210","attemptState":"完全不会","cause":"知识概念","masteryFeeling":1,"summary":"上次写的归纳","adoptedAi":false,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    guard case .confirming = store.reflectionPhase else { return XCTFail("应进入确认页") }
    let record = try XCTUnwrap(store.reflectionPreviousRecord, "已有复盘记录时暴露给学生作「上次的选择」")
    XCTAssertEqual(record.attemptState, "完全不会")
    XCTAssertEqual(record.cause, "知识概念")
    XCTAssertEqual(record.summary, "上次写的归纳")
  }

  func testAskEnded409DetailFailureReturnsToIdleWithError() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask", status: 409, body: Self.askEnded409)
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/reflection", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"服务暂时不可用，请稍后再试。"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    XCTAssertEqual(store.reflectionPhase, .idle, "读复盘详情失败回到 idle，可重试")
    XCTAssertEqual(store.lastError, "服务暂时不可用，请稍后再试。")
    XCTAssertFalse(store.isBusyReflection)
  }

  /// 正常路径发起追问时清掉上一题的「上次的选择」，不串题。
  func testStartReflectionClearsPreviousRecord() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask", status: 409, body: Self.askEnded409)
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"turns":[],"suggestion":null,"reflection":{"id":"dia_9f8e7d6c5b4a3210","attemptState":"完全不会","cause":"知识概念","masteryFeeling":1,"summary":null,"adoptedAi":false,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    XCTAssertNotNil(store.reflectionPreviousRecord)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID2)/reflection/ask",
      body: #"{"turn":1,"question":"这题你当时卡在哪一步？","source":"fallback"}"#)
    await store.startReflection(itemID: Self.itemID2)
    XCTAssertNil(store.reflectionPreviousRecord, "新题发起追问后不再带上一题的上次选择")
  }

  // MARK: - 3. lastReturnResults

  func testSubmitReturnKeepsLastReturnResults() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/return",
      body: #"{"results":[{"itemId":"itm_0a1b2c3d4e5f6071","ok":true,"toStatus":"temporarily_mastered","reason":"延迟 3–7 天独立做对，进入暂时掌握"},{"itemId":"itm_1111111111111111","ok":false,"error":"实际作答日期不能是未来日期"}]}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    let store = try makeStore()
    let accepted = V2ReturnEntry(itemId: Self.itemID, completion: .independent, correct: true, performedOn: "2026-10-02", stuckStep: nil)
    let rejected = V2ReturnEntry(itemId: Self.itemID2, completion: .hint1, correct: false, performedOn: "2027-01-01", stuckStep: nil)
    await store.submitReturn(practiceID: Self.packetID, entries: [accepted, rejected])
    let okResult = store.lastReturnResults.first { $0.itemId == Self.itemID }
    XCTAssertEqual(okResult?.reason, "延迟 3–7 天独立做对，进入暂时掌握",
      "保留成功条目服务器给的那句话，供「已记录」区显示")
    let rejectedResult = store.lastReturnResults.first { $0.itemId == Self.itemID2 }
    XCTAssertEqual(rejectedResult?.ok, false)
  }

  func testSubmitReturnNetworkFailureClearsLastReturnResults() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/return",
      body: #"{"results":[{"itemId":"itm_0a1b2c3d4e5f6071","ok":true,"toStatus":"temporarily_mastered","reason":"延迟 3–7 天独立做对，进入暂时掌握"}]}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    let store = try makeStore()
    let accepted = V2ReturnEntry(itemId: Self.itemID, completion: .independent, correct: true, performedOn: "2026-10-02", stuckStep: nil)
    await store.submitReturn(practiceID: Self.packetID, entries: [accepted])
    XCTAssertEqual(store.lastReturnResults.count, 1)
    // 网络失败的这次提交不得留下过期结果（界面靠 pendingReturns 判断未发出）。
    LoopSyntheticProtocol.enqueueTransportFailure("POST", "/v2/practice/\(Self.packetID)/return", code: .notConnectedToInternet)
    let again = V2ReturnEntry(itemId: Self.itemID2, completion: .independent, correct: true, performedOn: "2026-10-02", stuckStep: nil)
    await store.submitReturn(practiceID: Self.packetID, entries: [again])
    XCTAssertTrue(store.lastReturnResults.isEmpty, "本次提交没发出去时清空上次结果，不误导界面")
  }

  // MARK: - 4. summary 按练习包区分

  func testLoadSummaryTracksPracticeID() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID2)/summary",
      body: #"{"answered":1,"total":2,"independentCorrect":0,"masteredNow":[],"again":[],"calibration":{"confidentTotal":0,"missedCount":0,"text":null,"items":[]},"nextConfirmOn":null}"#)
    let store = try makeStore()
    await store.loadSummary(practiceID: Self.packetID)
    XCTAssertEqual(store.summaryPracticeID, Self.packetID)
    XCTAssertEqual(store.summary?.answered, 3)
    await store.loadSummary(practiceID: Self.packetID2)
    XCTAssertEqual(store.summaryPracticeID, Self.packetID2, "打开别的练习时回报随之替换")
    XCTAssertEqual(store.summary?.answered, 1)
  }

  func testSummaryPracticeIDSurvivesCacheRoundTrip() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("LoopStoreT6d-" + UUID().uuidString)
    let online = try makeStore(directory: directory)
    await online.loadSummary(practiceID: Self.packetID)
    let relaunched = try makeStore(client: false, directory: directory)
    XCTAssertEqual(relaunched.summaryPracticeID, Self.packetID, "离线缓存里的回报也记得属于哪份练习")
    XCTAssertEqual(relaunched.summary?.answered, 3)
  }
}
