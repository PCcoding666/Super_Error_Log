import XCTest
import Foundation
@testable import StudentCore

// T6b RED: LoopStore——学生一周闭环的界面状态。URLProtocol 合成传输，不连真实服务。
@MainActor final class LoopStoreTests: XCTestCase {
  static let itemID = "itm_0a1b2c3d4e5f6071"
  static let itemID2 = "itm_1111111111111111"
  static let packetID = "pkt_1a2b3c4d5e6f7081"
  static let proposalID = "crp_a1b2c3d4e5f60718"
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let jpeg = Data([0xff, 0xd8, 0xff, 0xd9])

  override func setUp() { LoopSyntheticProtocol.reset() }

  private func makeStore(client: Bool = true, directory: URL? = nil,
    pollInterval: Duration = .milliseconds(5), pollTimeout: Duration = .seconds(1)) throws -> LoopStore {
    let directory = directory ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("LoopStore-" + UUID().uuidString)
    guard client else { return LoopStore(client: nil, cacheDirectory: directory, pollInterval: pollInterval, pollTimeout: pollTimeout) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoopSyntheticProtocol.self]
    let pairing = try PairingConfiguration(baseURL: "http://127.0.0.1:3196", token: "loop-synthetic-token")
    return LoopStore(client: V2Client(configuration: pairing, sessionConfiguration: configuration),
      cacheDirectory: directory, pollInterval: pollInterval, pollTimeout: pollTimeout)
  }

  private func waitUntil(_ predicate: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<200 {
      if predicate() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("未等到预期状态", file: file, line: line)
  }

  // MARK: - 周视图

  func testRefreshWeekSuccessStoresWeekAndPersistsCache() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("LoopStore-" + UUID().uuidString)
    let store = try makeStore(directory: directory)
    await store.refreshWeek()
    XCTAssertEqual(store.week?.week, "2026-W40")
    XCTAssertNil(store.weekIssue)
    XCTAssertFalse(store.isShowingCache)
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("loop-cache.json").path), "刷新成功后落盘缓存")
  }

  func testRefreshWeekServerFailureKeepsOldDataAndClassifiesIssue() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let store = try makeStore()
    await store.refreshWeek()
    LoopSyntheticProtocol.enqueueFailure("GET", "/v2/week", status: 503, message: "服务暂不可用")
    await store.refreshWeek()
    XCTAssertEqual(store.week?.week, "2026-W40", "失败保留旧数据")
    XCTAssertEqual(store.weekIssue, .serviceUnavailable)
  }

  func testRefreshWeekUnauthorizedClassified() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", status: 401, body: #"{"error":{"code":"unauthorized","message":"本地配对令牌无效。"}}"#)
    let store = try makeStore()
    await store.refreshWeek()
    XCTAssertEqual(store.weekIssue, .unauthorized)
    XCTAssertNil(store.week)
  }

  func testRefreshWeekOfflineClassified() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let store = try makeStore()
    await store.refreshWeek()
    LoopSyntheticProtocol.enqueueTransportFailure("GET", "/v2/week", code: .notConnectedToInternet)
    await store.refreshWeek()
    XCTAssertEqual(store.weekIssue, .offline)
    XCTAssertEqual(store.week?.week, "2026-W40")
  }

  func testRefreshWeekWithoutClientKeepsCacheSilently() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("LoopStore-" + UUID().uuidString)
    let online = try makeStore(directory: directory)
    await online.refreshWeek()
    let offline = try makeStore(client: false, directory: directory)
    XCTAssertTrue(offline.isShowingCache)
    await offline.refreshWeek()
    XCTAssertEqual(offline.week?.week, "2026-W40", "未配对时不发请求、保留缓存显示")
    XCTAssertTrue(offline.isShowingCache)
  }

  // MARK: - 不是错题 / 恢复

  func testDiscardSuccessRemovesItemInPlace() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/discard",
      body: #"{"id":"itm_0a1b2c3d4e5f6071","status":"archived_not_worth_review"}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.discard(itemID: Self.itemID)
    XCTAssertTrue(store.week?.items.isEmpty == true, "成功后就地从列表移除，不整页重取")
    XCTAssertEqual(store.discardedItems.map(\.id), [Self.itemID])
    XCTAssertNil(store.lastError)
  }

  func testDiscardConflictKeepsCardAndShowsServerMessage() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/discard", status: 409,
      body: #"{"error":{"code":"conflict","message":"该题已在未回传的练习包中，请先完成练习回传。"}}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.discard(itemID: Self.itemID)
    XCTAssertEqual(store.week?.items.count, 1, "失败不得改动本地列表")
    XCTAssertEqual(store.lastError, "该题已在未回传的练习包中，请先完成练习回传。")
  }

  func testRestoreAddsCardBackInPlace() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/discard",
      body: #"{"id":"itm_0a1b2c3d4e5f6071","status":"archived_not_worth_review"}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/restore",
      body: #"{"id":"itm_0a1b2c3d4e5f6071","status":"ready_for_reflection"}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.discard(itemID: Self.itemID)
    await store.restore(itemID: Self.itemID)
    XCTAssertEqual(store.week?.items.count, 1, "恢复成功后就地加回")
    XCTAssertEqual(store.week?.items[0].status, .readyForReflection)
    XCTAssertTrue(store.discardedItems.isEmpty)
  }

  // MARK: - 设置

  func testSettingsLoadAndSave() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/settings", body: #"{"practiceSlot":"本周内","paperLocation":"varies"}"#)
    LoopSyntheticProtocol.respond("PUT", "/v2/settings", body: #"{"practiceSlot":"周三晚自习","paperLocation":"school"}"#)
    let store = try makeStore()
    await store.loadSettings()
    XCTAssertEqual(store.settings?.practiceSlot, "本周内")
    await store.saveSettings(practiceSlot: "周三晚自习", paperLocation: .school)
    XCTAssertEqual(store.settings?.paperLocation, .school)
    XCTAssertNil(store.lastError)
  }

  // MARK: - 推荐与勾选

  func testLoadRecommendationSeedsSelectionFromRecommended() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/recommend", body: Self.recommendTwoJSON)
    let store = try makeStore()
    await store.loadRecommendation()
    XCTAssertEqual(store.recommended.count, 2)
    XCTAssertEqual(store.selectedItemIDs, [Self.itemID, Self.itemID2], "初始勾选为推荐的那几道")
    XCTAssertEqual(store.notes.count, 1)
    XCTAssertEqual(store.limits?.max, 8)
  }

  func testSelectionRespectsOneToEightBounds() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/recommend", body: Self.recommendJSON(recommended: 2, others: 7))
    let store = try makeStore()
    await store.loadRecommendation()
    XCTAssertEqual(store.selectedItemIDs.count, 2)
    for index in 2..<8 { store.selectItem(String(format: "itm_%016x", index + 1)) }
    XCTAssertEqual(store.selectedItemIDs.count, 8)
    store.selectItem(String(format: "itm_%016x", 9))
    XCTAssertEqual(store.selectedItemIDs.count, 8, "至多 8 道")
    for _ in 0..<10 { store.deselectItem(store.selectedItemIDs[0]) }
    XCTAssertEqual(store.selectedItemIDs.count, 1, "至少保留 1 道")
    store.selectItem("itm_ffffffffffffffff")
    XCTAssertEqual(store.selectedItemIDs.count, 1, "候选之外的题不能勾选")
  }

  // MARK: - 建练习

  func testCreatePracticeSuccessClearsRecommendationState() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/recommend", body: Self.recommendTwoJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/practice", body: V2ClientTests.detailJSON)
    let store = try makeStore()
    await store.loadRecommendation()
    await store.createPractice(practiceSlot: "周三晚自习")
    XCTAssertEqual(store.currentPractice?.id, Self.packetID)
    XCTAssertTrue(store.recommended.isEmpty)
    XCTAssertTrue(store.others.isEmpty)
    XCTAssertTrue(store.notes.isEmpty)
    XCTAssertNil(store.limits)
    XCTAssertTrue(store.selectedItemIDs.isEmpty, "成功后清空推荐状态")
    XCTAssertNil(store.lastError)
  }

  func testCreatePracticeConflictShowsMessageAndRefetchesRecommendation() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/recommend", body: Self.recommendTwoJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/practice", status: 409,
      body: #"{"error":{"code":"conflict","message":"以下题目当前不可安排：itm_0a1b2c3d4e5f6071"}}"#)
    let store = try makeStore()
    await store.loadRecommendation()
    await store.createPractice(practiceSlot: nil)
    XCTAssertEqual(store.lastError, "以下题目当前不可安排：itm_0a1b2c3d4e5f6071")
    XCTAssertNil(store.currentPractice)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/recommend").count, 2,
      "409 时重新取推荐")
    XCTAssertEqual(store.selectedItemIDs, [Self.itemID, Self.itemID2])
  }

  // MARK: - 练习列表与详情

  func testLoadPracticesDefaultsCurrentPracticeToLatest() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice",
      body: #"{"packets":[{"id":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","status":"scheduled","practiceSlot":"周三晚自习","createdAt":"2026-09-30T08:20:00.000Z","generatedAt":null,"itemCount":3}]}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)", body: V2ClientTests.detailJSON)
    let store = try makeStore()
    await store.loadPractices()
    XCTAssertEqual(store.practices.count, 1)
    XCTAssertEqual(store.currentPractice?.id, Self.packetID, "currentPractice 默认取最新一份")
    XCTAssertEqual(store.currentPractice?.items.count, 1)
  }

  // MARK: - 复盘状态机

  private func primeAsk(question: String = "你原来写 x=1，这一步当时是怎么想的？") {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask",
      body: #"{"turn":1,"question":"\#(question)","source":"ai"}"#)
  }

  func testReflectionSingleTurnFlow() async throws {
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"把移项当成了照抄，漏了变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let store = try makeStore()
    XCTAssertEqual(store.reflectionPhase, .idle)
    await store.startReflection(itemID: Self.itemID)
    XCTAssertEqual(store.reflectionPhase, .waitingAnswer(question: "你原来写 x=1，这一步当时是怎么想的？", turn: 1))
    await store.answerFollowup("我以为移项不用变号，直接就抄过来了")
    XCTAssertEqual(store.reflectionPhase,
      .confirming(summary: "把移项当成了照抄，漏了变号", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错"))
    await store.submitReflection(attemptState: "方法基本正确但步骤出错", cause: "推理步骤", masteryFeeling: 3, summary: nil)
    XCTAssertEqual(store.reflectionPhase, .done)
    XCTAssertNil(store.lastError)
  }

  func testReflectionTwoTurnFlow() async throws {
    primeAsk()
    LoopSyntheticProtocol.enqueue("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":"等号另一边你是怎么处理的？"}"#)
    LoopSyntheticProtocol.enqueue("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":2,"summary":"两边都照抄了，没有变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"两边都照抄了，没有变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    XCTAssertEqual(store.reflectionPhase, .waitingAnswer(question: "等号另一边你是怎么处理的？", turn: 2), "有第二轮问题时回到 waitingAnswer")
    await store.answerFollowup("另一边也直接抄了")
    XCTAssertEqual(store.reflectionPhase,
      .confirming(summary: "两边都照抄了，没有变号", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错"))
    await store.submitReflection(attemptState: "方法基本正确但步骤出错", cause: "推理步骤", masteryFeeling: 2, summary: nil)
    XCTAssertEqual(store.reflectionPhase, .done)
  }

  func testReflectionSummarizeFailureFallsBackToManualChoices() async throws {
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":null,"suggestedCause":null,"suggestedAttemptState":null,"secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"完全不会","cause":"知识概念","masteryFeeling":0,"summary":null,"adoptedAi":false,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我不知道")
    XCTAssertEqual(store.reflectionPhase, .confirming(summary: nil, suggestedCause: nil, suggestedAttemptState: nil),
      "归纳失败进入手选")
    await store.submitReflection(attemptState: "完全不会", cause: "知识概念", masteryFeeling: 0, summary: nil)
    XCTAssertEqual(store.reflectionPhase, .done)
  }

  func testReflectionAskFailureReturnsToIdle() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"追问服务暂时不可用，请稍后再试。"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    XCTAssertEqual(store.reflectionPhase, .idle, "失败回到上一个稳定状态")
    XCTAssertEqual(store.lastError, "追问服务暂时不可用，请稍后再试。")
  }

  func testReflectionAnswerFailureReturnsToWaitingAnswer() async throws {
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"这次没归纳出来，请再说一次。"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    XCTAssertEqual(store.reflectionPhase, .waitingAnswer(question: "你原来写 x=1，这一步当时是怎么想的？", turn: 1))
    XCTAssertEqual(store.lastError, "这次没归纳出来，请再说一次。")
  }

  func testReflectionSubmitFailureReturnsToConfirming() async throws {
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection", status: 500,
      body: #"{"error":{"code":"invalid_request","message":"服务暂时无法保存，请稍后再试。"}}"#)
    let store = try makeStore()
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    await store.submitReflection(attemptState: "方法基本正确但步骤出错", cause: "推理步骤", masteryFeeling: 3, summary: nil)
    XCTAssertEqual(store.reflectionPhase,
      .confirming(summary: "把移项当成了照抄，漏了变号", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错"),
      "提交失败回到 confirming，学生已选内容不丢")
    XCTAssertEqual(store.lastError, "服务暂时无法保存，请稍后再试。")
  }

  func testReflectionSubmitUpdatesPracticeItemAndWeekCard() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)", body: V2ClientTests.detailJSON)
    primeAsk()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"把移项当成了照抄，漏了变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.openPractice(id: Self.packetID)
    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    await store.submitReflection(attemptState: "方法基本正确但步骤出错", cause: "推理步骤", masteryFeeling: 3, summary: nil)
    XCTAssertEqual(store.currentPractice?.items[0].reflected, true, "提交成功后更新题卡 reflected")
    XCTAssertEqual(store.currentPractice?.items[0].status, .eligibleForReview)
    XCTAssertEqual(store.week?.items[0].status, .eligibleForReview)
  }

  // MARK: - 修改识别结果

  private func primeEvidence(revision: Int = 1) {
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/evidence",
      body: #"{"questionText":"已知 x+y=1，求 x 的值。","subject":"数学","knowledgeTags":["一元一次方程"],"observations":[{"id":"o1","kind":"student_work","text":"x=1"}],"badge":"ok","revision":\#(revision)}"#)
  }

  func testProposeThenAcceptUpdatesWeekCard() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    primeEvidence()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct",
      body: #"{"proposalId":"crp_a1b2c3d4e5f60718","revision":1,"changes":[{"field":"questionText","before":"已知 x+y=1，求 x 的值。","after":"已知 x+y=1，求 y 的值。","find":"x 的值","replace":"y 的值"}],"clarify":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct/accept",
      body: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 y 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.loadEvidence(itemID: Self.itemID)
    XCTAssertEqual(store.evidence?.revision, 1)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertEqual(store.proposal?.proposalId, Self.proposalID)
    let requestIDs = correctionRequestIDs()
    XCTAssertEqual(requestIDs.count, 1)
    XCTAssertNotNil(UUID(uuidString: requestIDs[0]), "每次生成建议生成新的 UUID clientRequestId")
    await store.acceptProposal()
    XCTAssertEqual(store.week?.items[0].questionExcerpt, "已知 x+y=1，求 y 的值。", "接受成功后用返回卡片更新本地列表")
    XCTAssertNil(store.proposal)
    XCTAssertNil(store.lastError)
  }

  // T6c：retryProposal 只用于连接失败（没有收到服务器回应）的原样重试；复用同一 clientRequestId。
  func testRetryProposalReusesClientRequestID() async throws {
    primeEvidence()
    LoopSyntheticProtocol.enqueueTransportFailure("POST", "/v2/items/\(Self.itemID)/correct", code: .notConnectedToInternet)
    LoopSyntheticProtocol.enqueue("POST", "/v2/items/\(Self.itemID)/correct",
      body: #"{"proposalId":"crp_a1b2c3d4e5f60718","revision":1,"changes":[{"field":"questionText","before":"已知 x+y=1，求 x 的值。","after":"已知 x+y=1，求 y 的值。","find":"x 的值","replace":"y 的值"}],"clarify":null}"#)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertNil(store.proposal)
    XCTAssertTrue(store.proposalRetryable, "连接失败才可原样重试")
    await store.retryProposal()
    XCTAssertEqual(store.proposal?.proposalId, Self.proposalID)
    let requestIDs = correctionRequestIDs()
    XCTAssertEqual(requestIDs.count, 2)
    XCTAssertEqual(requestIDs[0], requestIDs[1], "连接失败的原样重试复用同一个 clientRequestId")
  }

  // 收到了服务器回应（502）的失败不可原样重试：retryProposal 直接返回，不发请求。
  func testRetryProposalAfterServerFailureDoesNothing() async throws {
    primeEvidence()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"这次没生成出可用的修改，请换个说法或用键盘直接改"}}"#)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .voice)
    XCTAssertNil(store.proposal)
    XCTAssertFalse(store.proposalRetryable)
    await store.retryProposal()
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/items/\(Self.itemID)/correct").count, 1,
      "收到服务器回应的失败不得原样重试（重试要换新请求标识）")
  }

  func testProposeConflictRefreshesEvidenceWithNotice() async throws {
    primeEvidence(revision: 3)
    let store = try makeStore()
    await store.loadEvidence(itemID: Self.itemID)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct", status: 409,
      body: #"{"error":{"code":"conflict","message":"识别结果已更新，请重新加载。"},"revision":4}"#)
    primeEvidence(revision: 4)
    await store.proposeCorrection(instruction: "题目求的是 y 不是 x", method: .keyboard)
    XCTAssertEqual(store.proposalNotice, "内容已更新，请再看一眼。")
    XCTAssertNil(store.proposal)
    XCTAssertEqual(store.evidence?.revision, 4, "409 时用新 revision 重新取识别结果")
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/items/\(Self.itemID)/evidence").count, 2)
  }

  func testApplyDirectSuccessUpdatesCard() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    primeEvidence()
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/correct/direct",
      body: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"物理","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.loadEvidence(itemID: Self.itemID)
    let change = V2CorrectionChange(field: .subject, observationId: nil, before: "数学", after: "物理", find: nil, replace: nil)
    await store.applyDirect(changes: [change])
    XCTAssertEqual(store.week?.items[0].subject, "物理")
    XCTAssertNotNil(store.evidence, "T6c-R1：成功后保留并重取识别结果（详情页不停在转圈）")
    XCTAssertNil(store.lastError)
  }

  // MARK: - 打印

  func testPrintPollsToReadyAndDownloadsAllMedia() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"preparing","progress":{"done":1,"total":2}}"#)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"ready","snapshot":\#(Self.snapshotWithMediaJSON)}"#)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"ready","snapshot":\#(Self.snapshotWithMediaJSON)}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/print/media/p0-crop.jpg", body: Self.jpeg, contentType: "image/jpeg")
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/print/media/p0-diagram.jpg", body: Self.jpeg, contentType: "image/jpeg")
    let store = try makeStore()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .ready = store.printPhase { return true }; return false }
    guard case .ready(let snapshot) = store.printPhase else { return XCTFail("应进入 ready") }
    XCTAssertTrue(snapshot.items[0].needsGlance)
    for name in ["p0-crop.jpg", "p0-diagram.jpg"] {
      let url = store.printMediaURL(packetID: Self.packetID, name: name)
      XCTAssertEqual(try Data(contentsOf: url), Self.jpeg, "快照登记的图片全部下载到缓存目录")
    }
    XCTAssertFalse(store.isBusyPrint)
    // 已存在的图片不重下：再次轮询到 ready 不发新的取图请求。
    await store.pollPrint(practiceID: Self.packetID)
    await waitUntil { if case .ready = store.printPhase { return true }; return false }
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)/print/media/p0-crop.jpg").count, 1)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)/print/media/p0-diagram.jpg").count, 1)
  }

  func testPrintFailedShowsServerMessage() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"failed","error":"原图读不到"}"#)
    let store = try makeStore()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .failed = store.printPhase { return true }; return false }
    XCTAssertEqual(store.printPhase, .failed("原图读不到"))
    XCTAssertFalse(store.isBusyPrint)
  }

  func testPrintCancelStopsPolling() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueueHold("GET", "/v2/practice/\(Self.packetID)/print",
      thenBody: #"{"status":"preparing","progress":{"done":1,"total":3}}"#)
    let store = try makeStore()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertEqual(store.printPhase, .preparing(nil))
    store.cancelPrint()
    XCTAssertEqual(store.printPhase, .none)
    XCTAssertFalse(store.isBusyPrint)
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)/print").count, 1,
      "取消后不再发轮询请求")
  }

  // T6c：轮询超时不再停在 preparing——统一进入 failed，唯一重试路径是再调 requestPrint（服务器幂等）。
  func testPrintTimeoutMarksFailedAndRetriesThroughRequestPrint() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print", status: 202, body: #"{"status":"preparing"}"#)
    for _ in 0..<30 {
      LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)/print",
        body: #"{"status":"preparing","progress":{"done":1,"total":3}}"#)
    }
    let store = try makeStore(pollInterval: .milliseconds(5), pollTimeout: .milliseconds(30))
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .failed = store.printPhase { return true }; return false }
    XCTAssertEqual(store.printPhase, .failed("打印准备时间太久，请再试一次。"))
    XCTAssertFalse(store.isBusyPrint)
    await store.requestPrint(practiceID: Self.packetID)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/practice/\(Self.packetID)/print").count, 2,
      "失败后唯一的重试路径是再调 requestPrint")
    store.cancelPrint()
  }

  // MARK: - 回传与回报

  func testSubmitReturnKeepsRejectedEntriesWithReasonsAndLoadsSummary() async throws {
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/return",
      body: #"{"results":[{"itemId":"itm_0a1b2c3d4e5f6071","ok":true,"toStatus":"temporarily_mastered","reason":"延迟 3–7 天独立做对，进入暂时掌握"},{"itemId":"itm_1111111111111111","ok":false,"error":"实际作答日期不能是未来日期"}]}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    let store = try makeStore()
    let accepted = V2ReturnEntry(itemId: Self.itemID, completion: .independent, correct: true, performedOn: "2026-10-02", stuckStep: nil)
    let rejected = V2ReturnEntry(itemId: Self.itemID2, completion: .hint1, correct: false, performedOn: "2027-01-01", stuckStep: nil)
    await store.submitReturn(practiceID: Self.packetID, entries: [accepted, rejected])
    XCTAssertEqual(store.pendingReturns, [rejected], "ok:true 的从待提交移除，ok:false 的保留")
    XCTAssertEqual(store.returnIssues[Self.itemID2], "实际作答日期不能是未来日期")
    XCTAssertNil(store.returnIssues[Self.itemID])
    XCTAssertEqual(store.summary?.answered, 3, "回传后调用 loadSummary")
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)/summary").count, 1)
  }

  // MARK: - 离线缓存

  func testCacheRoundTripShowsCacheOnLaunch() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("GET", "/v2/settings", body: #"{"practiceSlot":"本周内","paperLocation":"varies"}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: V2ModelTests.summaryJSON)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("LoopStore-" + UUID().uuidString)
    let online = try makeStore(directory: directory)
    await online.refreshWeek()
    await online.loadSettings()
    await online.loadSummary(practiceID: Self.packetID)
    let relaunched = try makeStore(directory: directory)
    XCTAssertTrue(relaunched.isShowingCache)
    XCTAssertNotNil(relaunched.cacheSavedAt)
    XCTAssertEqual(relaunched.week, online.week)
    XCTAssertEqual(relaunched.settings, online.settings)
    XCTAssertEqual(relaunched.summary?.answered, 3)
    await relaunched.refreshWeek()
    XCTAssertFalse(relaunched.isShowingCache, "联网刷新成功后不再是缓存显示")
  }

  func testCorruptCacheIsDeletedAndIgnored() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("LoopStore-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let cacheURL = directory.appendingPathComponent("loop-cache.json")
    try Data("not-json-at-all".utf8).write(to: cacheURL)
    let store = try makeStore(directory: directory)
    XCTAssertNil(store.week)
    XCTAssertFalse(store.isShowingCache)
    XCTAssertNil(store.cacheSavedAt)
    XCTAssertFalse(FileManager.default.fileExists(atPath: cacheURL.path), "损坏缓存删除，不阻塞启动")
  }

  // MARK: - 图片缓存

  func testCropFileURLDeduplicatesConcurrentDownloads() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/items/\(Self.itemID)/crop", body: Self.jpeg, contentType: "image/jpeg")
    let store = try makeStore()
    async let first = store.cropFileURL(itemID: Self.itemID)
    async let second = store.cropFileURL(itemID: Self.itemID)
    let (firstURL, secondURL) = await (first, second)
    XCTAssertNotNil(firstURL)
    XCTAssertEqual(firstURL, secondURL)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(firstURL)), Self.jpeg)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/items/\(Self.itemID)/crop").count, 1,
      "并发请求同一张图只下载一次")
    _ = await store.cropFileURL(itemID: Self.itemID)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/items/\(Self.itemID)/crop").count, 1,
      "已缓存直接返回，不再请求")
  }

  // MARK: - 忙碌标记

  func testBusyReflectionIgnoresSecondCall() async throws {
    LoopSyntheticProtocol.enqueueHold("POST", "/v2/items/\(Self.itemID)/reflection/ask",
      thenBody: #"{"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai"}"#)
    let store = try makeStore()
    let first = Task { await store.startReflection(itemID: Self.itemID) }
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyReflection)
    await store.startReflection(itemID: Self.itemID)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/items/\(Self.itemID)/reflection/ask").count, 1,
      "进行中重复调用不发第二个请求")
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    XCTAssertEqual(store.reflectionPhase, .waitingAnswer(question: "你原来写 x=1，这一步当时是怎么想的？", turn: 1))
    XCTAssertFalse(store.isBusyReflection)
  }

  func testBusyPrintIgnoresSecondCall() async throws {
    LoopSyntheticProtocol.enqueueHold("POST", "/v2/practice/\(Self.packetID)/print", thenStatus: 202, thenBody: #"{"status":"preparing"}"#)
    LoopSyntheticProtocol.enqueueHold("GET", "/v2/practice/\(Self.packetID)/print",
      thenBody: #"{"status":"preparing","progress":{"done":1,"total":3}}"#)
    let store = try makeStore()
    let first = Task { await store.requestPrint(practiceID: Self.packetID) }
    await waitUntil { LoopSyntheticProtocol.pendingCount > 0 }
    XCTAssertTrue(store.isBusyPrint)
    await store.requestPrint(practiceID: Self.packetID)
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "POST", path: "/v2/practice/\(Self.packetID)/print").count, 1)
    LoopSyntheticProtocol.releaseHeld()
    await first.value
    store.cancelPrint()
  }

  // MARK: - 夹具

  /// 已发出的"生成修改建议"请求里的 clientRequestId 列表（按发出顺序）。
  private func correctionRequestIDs() -> [String] {
    LoopSyntheticProtocol.requests(method: "POST", path: "/v2/items/\(Self.itemID)/correct").compactMap { request in
      guard let body = request.httpBody,
        let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
      return object["clientRequestId"] as? String
    }
  }

  static let recommendTwoJSON = #"{"recommended":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false},{"id":"itm_1111111111111111","shortId":"M-13","subject":"数学","knowledgeTags":["分式"],"questionExcerpt":"化简分式。","badge":"ok","status":"eligible_for_review","cropUrl":"/v2/items/itm_1111111111111111/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false}],"others":[],"notes":["本周可安排题目仅 2 道，不足 5 道，已全部纳入"],"limits":{"min":5,"max":8}}"#

  static func recommendJSON(recommended: Int, others: Int) -> String {
    func card(_ index: Int) -> String {
      let id = String(format: "itm_%016x", index + 1)
      return #"{"id":"\#(id)","shortId":"M-\#(index)","subject":"数学","knowledgeTags":["方程"],"questionExcerpt":"第 \#(index) 题","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/\#(id)/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false}"#
    }
    let recommendedCards = (0..<recommended).map(card).joined(separator: ",")
    let otherCards = (recommended..<(recommended + others)).map(card).joined(separator: ",")
    return #"{"recommended":[\#(recommendedCards)],"others":[\#(otherCards)],"notes":[],"limits":{"min":5,"max":8}}"#
  }

  static let snapshotWithMediaJSON = #"{"packetId":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","preparedAt":"2026-09-30T08:21:00.000Z","cover":{"title":"本周练习","practiceSlot":"周三晚自习","rules":["不看答案，独立做"],"itemList":[{"shortId":"M-12","sourceLabel":"原题"}]},"items":[{"itemId":"itm_0a1b2c3d4e5f6071","shortId":"M-12","position":0,"subject":"数学","knowledgeTags":["一元一次方程"],"mode":"crop","stemText":null,"cropMedia":"p0-crop.jpg","diagramMedia":["p0-diagram.jpg"],"keyStepPrompt":"这题的关键一步是：","checkboxes":["独立做出"],"needsGlance":true,"glanceReason":"这题的手写内容可能没有遮全，打印前请看一眼原图"}],"answerSheet":[{"shortId":"M-12","hint1":null,"hint2":null,"answer":{"text":null,"source":"none","label":null},"fallbackNote":"对照原卷第 1 题"}]}"#
}

/// T6b 合成传输：永久路由（respond）+ 队列路由（enqueue，按序弹出）+ 传输错误 + hold/release。
/// 队列为空回落到永久路由，再落空回 404 信封。记录全部请求（含正文）。
final class LoopSyntheticProtocol: URLProtocol, @unchecked Sendable {
  private struct Response {
    let status: Int
    let body: Data
    let contentType: String
  }
  private enum Step {
    case respond(Response)
    case transportFailure(URLError.Code)
    case hold(Response)
  }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  nonisolated(unsafe) private static var permanent: [String: Step] = [:]
  nonisolated(unsafe) private static var queues: [String: [Step]] = [:]
  nonisolated(unsafe) private static var held: [(LoopSyntheticProtocol, Response)] = []

  static var pendingCount: Int { lock.withLock { held.count } }
  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  static func requests(method: String, path: String) -> [URLRequest] {
    lock.withLock { recorded.filter { ($0.httpMethod ?? "GET") == method && $0.url?.path == path } }
  }
  static func reset() {
    lock.withLock { recorded = []; permanent = [:]; queues = [:]; held = [] }
  }
  static func respond(_ method: String, _ path: String, status: Int = 200, body: String, contentType: String = "application/json") {
    respond(method, path, status: status, body: Data(body.utf8), contentType: contentType)
  }
  static func respond(_ method: String, _ path: String, status: Int = 200, body: Data, contentType: String) {
    lock.withLock { permanent[key(method, path)] = .respond(Response(status: status, body: body, contentType: contentType)) }
  }
  static func enqueue(_ method: String, _ path: String, status: Int = 200, body: String, contentType: String = "application/json") {
    lock.withLock {
      queues[key(method, path), default: []].append(.respond(Response(status: status, body: Data(body.utf8), contentType: contentType)))
    }
  }
  /// 以错误信封响应（默认 404 之外的失败分类测试用）。
  static func enqueueFailure(_ method: String, _ path: String, status: Int, message: String) {
    enqueue(method, path, status: status, body: #"{"error":{"code":"invalid_request","message":"\#(message)"}}"#)
  }
  static func enqueueTransportFailure(_ method: String, _ path: String, code: URLError.Code) {
    lock.withLock { queues[key(method, path), default: []].append(.transportFailure(code)) }
  }
  static func enqueueHold(_ method: String, _ path: String, thenStatus: Int = 200, thenBody: String, thenContentType: String = "application/json") {
    lock.withLock {
      queues[key(method, path), default: []].append(.hold(Response(status: thenStatus, body: Data(thenBody.utf8), contentType: thenContentType)))
    }
  }
  static func releaseHeld() {
    let batch = lock.withLock { let value = held; held = []; return value }
    for (instance, response) in batch { instance.deliver(response) }
  }
  private static func key(_ method: String, _ path: String) -> String { method + " " + path }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var captured = request
    if let stream = request.httpBodyStream {
      stream.open()
      var bytes = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        bytes.append(buffer, count: count)
      }
      stream.close()
      captured.httpBody = bytes
    }
    let step = Self.lock.withLock { () -> Step in
      Self.recorded.append(captured)
      let key = Self.key(request.httpMethod ?? "GET", request.url?.path ?? "")
      if var queue = Self.queues[key], !queue.isEmpty {
        let step = queue.removeFirst()
        Self.queues[key] = queue
        return step
      }
      if let step = Self.permanent[key] { return step }
      return .respond(Response(status: 404,
        body: Data(#"{"error":{"code":"not_found","message":"接口不存在。"}}"#.utf8),
        contentType: "application/json"))
    }
    switch step {
    case .respond(let response): deliver(response)
    case .transportFailure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
    case .hold(let response): Self.lock.withLock { Self.held.append((self, response)) }
    }
  }

  private func deliver(_ response: Response) {
    let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: nil,
      headerFields: ["Content-Type": response.contentType])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: response.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
