import XCTest
import Foundation
@testable import StudentCore

// T6p RED: 练习卡状态句与下一步（task-6p-brief §5）。
final class PracticeCardTextTests: XCTestCase {

  private func makeItem(_ index: Int, reflected: Bool) -> V2PracticeItem {
    V2PracticeItem(
      id: "itm_\(index)", shortId: "M-0\(index + 1)", subject: "数学",
      knowledgeTags: [], questionExcerpt: nil, badge: .ok,
      status: .packetGenerated, cropUrl: "/v2/items/itm_\(index)/crop",
      jobId: "job-\(index)", reason: "本周新错题", tier: 4, reflected: reflected, position: index)
  }

  private func makeDetail(count: Int = 3, reflectedCount: Int = 3, printed: Bool = false, slot: String? = "周三晚自习") -> V2PracticeDetail {
    V2PracticeDetail(
      id: "pkt_1", week: "2026-W40", status: "packet_generated", practiceSlot: slot,
      createdAt: Date(timeIntervalSince1970: 1_759_000_000),
      generatedAt: printed ? Date(timeIntervalSince1970: 1_759_100_000) : nil,
      items: (0..<count).map { makeItem($0, reflected: $0 < reflectedCount) })
  }

  private func makeSummary(answered: Int, total: Int = 3) -> V2ReturnSummary {
    V2ReturnSummary(
      answered: answered, total: total, independentCorrect: 0,
      masteredNow: [], again: [],
      calibration: V2Calibration(confidentTotal: 0, missedCount: 0, text: nil, items: []),
      nextConfirmOn: nil)
  }

  // MARK: - 状态句

  func testNotPrintedWithUnreflectedItems() {
    let content = PracticeCardText.make(detail: makeDetail(count: 3, reflectedCount: 1, printed: false), summary: nil)
    XCTAssertEqual(content.statusLine, "3 道题 · 周三晚自习 · 还有 2 道没复盘 · 还没打印")
  }

  func testNotPrintedAllReflected() {
    let content = PracticeCardText.make(detail: makeDetail(count: 3, reflectedCount: 3, printed: false), summary: nil)
    XCTAssertEqual(content.statusLine, "3 道题 · 周三晚自习 · 还没打印")
  }

  func testPrintedWithoutAnyReturn() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: nil)
    XCTAssertEqual(content.statusLine, "3 道题 · 周三晚自习 · 已打印，做完回来录结果")
  }

  func testPrintedWithPartialReturn() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: makeSummary(answered: 2))
    XCTAssertEqual(content.statusLine, "3 道题 · 周三晚自习 · 已录 2/3 道")
  }

  func testAllReturned() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: makeSummary(answered: 3))
    XCTAssertEqual(content.statusLine, "3 道题 · 周三晚自习 · 已录完")
  }

  func testSlotOmittedWhenMissing() {
    let content = PracticeCardText.make(detail: makeDetail(slot: nil), summary: nil)
    XCTAssertEqual(content.statusLine, "3 道题 · 还没打印")
  }

  // MARK: - 下一步

  func testNextStepsBeforePrinting() {
    let withUnreflected = PracticeCardText.make(detail: makeDetail(reflectedCount: 1, printed: false), summary: nil)
    XCTAssertEqual(withUnreflected.steps, [.reflect, .print])
    let allReflected = PracticeCardText.make(detail: makeDetail(reflectedCount: 3, printed: false), summary: nil)
    XCTAssertEqual(allReflected.steps, [.print], "都复盘完了就不需要'去复盘'，没复盘完也允许打印")
  }

  func testNextStepsAfterPrintingBeforeAnyReturn() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: nil)
    XCTAssertEqual(content.steps, [.record, .reprint])
  }

  func testNextStepsAfterPartialReturn() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: makeSummary(answered: 1))
    XCTAssertEqual(content.steps, [.record, .reprint, .viewSummary], "已录过至少一道时可以看结果")
  }

  func testNextStepsAfterAllReturned() {
    let content = PracticeCardText.make(detail: makeDetail(printed: true), summary: makeSummary(answered: 3))
    XCTAssertEqual(content.steps, [.viewSummary, .reprint])
  }

  func testStepTitlesAreChinese() {
    XCTAssertEqual(PracticeCardText.NextStep.reflect.title, "去复盘")
    XCTAssertEqual(PracticeCardText.NextStep.print.title, "打印练习纸")
    XCTAssertEqual(PracticeCardText.NextStep.reprint.title, "再打印一份")
    XCTAssertEqual(PracticeCardText.NextStep.record.title, "录结果")
    XCTAssertEqual(PracticeCardText.NextStep.viewSummary.title, "看结果")
  }
}
