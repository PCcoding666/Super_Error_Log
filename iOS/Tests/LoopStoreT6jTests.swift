import XCTest
import Foundation
@testable import StudentCore

// T6j RED：打印就绪后练习详情/列表/周视图随即刷新（练习卡出现「录结果」）；
// 复盘、录结果成功后练习卡状态句跟上。URLProtocol 合成传输，不连真实服务。
@MainActor final class LoopStoreT6jTests: XCTestCase {
  static let itemID = "itm_0a1b2c3d4e5f6071"
  static let packetID = "pkt_1a2b3c4d5e6f7081"

  override func setUp() { LoopSyntheticProtocol.reset() }

  private func makeStore(pollInterval: Duration = .milliseconds(5),
    pollTimeout: Duration = .seconds(1)) throws -> LoopStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("LoopStoreT6j-" + UUID().uuidString)
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

  // MARK: - §1 打印就绪后练习卡跟上

  /// 打印就绪（快照图片到齐）后：重取练习详情，currentPractice.generatedAt 变为非空，
  /// 练习列表对应项同步更新，本周错题重新取一次；练习卡下一步出现「录结果」。
  func testPrintReadyRefreshesPracticeDetailListAndWeek() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("GET", "/v2/practice", body: Self.listJSON(generatedAt: "null"))
    // 首次打开：还没打印；打印就绪后重取：已打印。
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)", body: V2ClientTests.detailJSON)
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)", body: Self.printedDetailJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"ready","snapshot":\#(V2ModelTests.snapshotJSON)}"#)
    let store = try makeStore()
    await store.refreshWeek()
    await store.loadPractices()
    XCTAssertNil(store.currentPractice?.generatedAt, "前置：还没打印")
    let before = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: nil)
    XCTAssertTrue(before.steps.contains(.print))
    XCTAssertFalse(before.steps.contains(.record))

    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .ready = store.printPhase { return true }; return false }
    await waitUntil { store.currentPractice?.generatedAt != nil }

    XCTAssertNotNil(store.currentPractice?.generatedAt, "打印就绪后重取详情，generatedAt 非空")
    XCTAssertNotNil(store.practices.first?.generatedAt, "练习列表对应项同步更新")
    XCTAssertEqual(LoopSyntheticProtocol.requests(method: "GET", path: "/v2/week").count, 2,
      "打印就绪后重新取本周错题")
    let card = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: nil)
    XCTAssertTrue(card.steps.contains(.record), "练习卡下一步出现「录结果」")
    XCTAssertFalse(card.steps.contains(.print))
    XCTAssertNil(store.lastError)
  }

  /// 打印就绪后的详情重取失败：不影响打印页显示（仍是 ready，不写错误），卡片晚一点更新。
  func testPrintReadyDetailRefreshFailureKeepsPrintPage() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    LoopSyntheticProtocol.respond("GET", "/v2/practice", body: Self.listJSON(generatedAt: "null"))
    LoopSyntheticProtocol.enqueue("GET", "/v2/practice/\(Self.packetID)", body: V2ClientTests.detailJSON)
    LoopSyntheticProtocol.enqueueFailure("GET", "/v2/practice/\(Self.packetID)", status: 503, message: "服务暂不可用")
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/print",
      body: #"{"status":"ready","snapshot":\#(V2ModelTests.snapshotJSON)}"#)
    let store = try makeStore()
    await store.loadPractices()
    await store.requestPrint(practiceID: Self.packetID)
    await waitUntil { if case .ready = store.printPhase { return true }; return false }
    await waitUntil {
      LoopSyntheticProtocol.requests(method: "GET", path: "/v2/practice/\(Self.packetID)").count >= 2
    }
    guard case .ready = store.printPhase else { return XCTFail("详情重取失败不得影响打印页") }
    XCTAssertNil(store.currentPractice?.generatedAt, "重取失败：卡片晚一点更新")
    XCTAssertNil(store.lastError, "重取失败不写错误提示")
  }

  // MARK: - §2 复盘 / 录结果后练习卡跟上

  /// 提交复盘成功后：练习卡「还有 N 道没复盘」随即减少。
  func testSubmitReflectionDecrementsUnreflectedInCardText() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)", body: V2ClientTests.detailJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/ask",
      body: #"{"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai"}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":null}"#)
    LoopSyntheticProtocol.respond("POST", "/v2/items/\(Self.itemID)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"把移项当成了照抄，漏了变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let store = try makeStore()
    await store.openPractice(id: Self.packetID)
    let before = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: nil)
    XCTAssertTrue(before.statusLine.contains("还有 1 道没复盘"), "前置：还没复盘")

    await store.startReflection(itemID: Self.itemID)
    await store.answerFollowup("我以为移项不用变号")
    await store.submitReflection(attemptState: "方法基本正确但步骤出错", cause: "推理步骤",
      masteryFeeling: 3, summary: nil)

    let after = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: nil)
    XCTAssertFalse(after.statusLine.contains("没复盘"), "提交复盘成功后状态句随即更新")
  }

  /// 录结果成功后：练习卡状态句变为「已录完」（已录 x/y 道），并出现「看结果」。
  func testSubmitReturnUpdatesCardStatusAndShowsSummaryStep() async throws {
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)", body: Self.printedDetailJSON)
    LoopSyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetID)/return",
      body: #"{"results":[{"itemId":"itm_0a1b2c3d4e5f6071","ok":true,"toStatus":"temporarily_mastered","reason":"延迟 3–7 天独立做对，进入暂时掌握"}]}"#)
    LoopSyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetID)/summary", body: Self.summaryAnsweredOneJSON)
    let store = try makeStore()
    await store.openPractice(id: Self.packetID)
    let before = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: nil)
    XCTAssertTrue(before.statusLine.contains("已打印，做完回来录结果"), "前置：已打印未录")
    XCTAssertTrue(before.steps.contains(.record))
    XCTAssertFalse(before.steps.contains(.viewSummary))

    let entry = V2ReturnEntry(itemId: Self.itemID, completion: .independent, correct: true,
      performedOn: "2026-10-02", stuckStep: nil)
    await store.submitReturn(practiceID: Self.packetID, entries: [entry])

    let after = PracticeCardText.make(detail: try XCTUnwrap(store.currentPractice), summary: store.summary)
    XCTAssertTrue(after.statusLine.contains("已录完"), "录结果成功后状态句随即变化")
    XCTAssertTrue(after.steps.contains(.viewSummary), "出现「看结果」")
    XCTAssertFalse(after.steps.contains(.record))
  }

  // MARK: - 夹具

  /// 已打印（generatedAt 非空）的练习详情。
  static let printedDetailJSON = #"{"id":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","status":"printed","practiceSlot":"周三晚自习","createdAt":"2026-09-30T08:20:00.000Z","generatedAt":"2026-09-30T08:22:00.000Z","items":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"scheduled","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false,"position":0}]}"#

  static func listJSON(generatedAt: String) -> String {
    #"{"packets":[{"id":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","status":"scheduled","practiceSlot":"周三晚自习","createdAt":"2026-09-30T08:20:00.000Z","generatedAt":\#(generatedAt),"itemCount":1}]}"#
  }

  static let summaryAnsweredOneJSON = #"{"answered":1,"total":1,"independentCorrect":1,"masteredNow":[],"again":[],"pending":[],"calibration":{"confidentTotal":0,"missedCount":0,"text":null,"items":[]},"nextConfirmOn":null}"#
}
