import XCTest
import Foundation
@testable import StudentCore

// T6p RED: 录结果表单规则（task-6p-brief §3，docs/mobile-v2-api.md §3.15）。
final class ReturnFormTests: XCTestCase {

  // MARK: - 夹具

  private func makeItem(_ index: Int) -> V2PracticeItem {
    V2PracticeItem(
      id: "itm_\(index)", shortId: "M-0\(index + 1)", subject: "数学",
      knowledgeTags: ["一元一次方程"], questionExcerpt: nil, badge: .ok,
      status: .packetGenerated, cropUrl: "/v2/items/itm_\(index)/crop",
      jobId: "job-\(index)", reason: "本周新错题", tier: 4, reflected: true, position: index)
  }

  private func makeDetail(count: Int = 3, generatedAt: Date? = Date(timeIntervalSince1970: 1_759_200_000)) -> V2PracticeDetail {
    V2PracticeDetail(
      id: "pkt_1", week: "2026-W40", status: "packet_generated", practiceSlot: "周三晚自习",
      createdAt: Date(timeIntervalSince1970: 1_759_000_000), generatedAt: generatedAt,
      items: (0..<count).map(makeItem))
  }

  /// 2026-09-30 15:30 UTC：奥克兰（UTC+13）已是 10-01 清晨，上海（UTC+8）还是 9-30 深夜。
  private func fixedInstant() -> Date {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    return utc.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 15, minute: 30))!
  }
  private func calendar(_ id: String) -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: id)!
    return c
  }

  private func makeForm(calendarId: String = "Asia/Shanghai") -> ReturnForm {
    ReturnForm(detail: makeDetail(), today: fixedInstant(), calendar: calendar(calendarId))
  }

  // MARK: - 本机日历日与时区边界

  func testCommonDateDefaultsToTodayInInjectedCalendar() {
    let shanghai = ReturnForm(detail: makeDetail(), today: fixedInstant(), calendar: calendar("Asia/Shanghai"))
    let auckland = ReturnForm(detail: makeDetail(), today: fixedInstant(), calendar: calendar("Pacific/Auckland"))
    XCTAssertEqual(shanghai.commonDate, "2026-09-30")
    XCTAssertEqual(auckland.commonDate, "2026-10-01", "同一时刻跨午夜时区的本机日历日必须不同")
  }

  func testDayStringHonoursCalendarTimeZone() {
    XCTAssertEqual(ReturnForm.dayString(fixedInstant(), calendar: calendar("Asia/Shanghai")), "2026-09-30")
    XCTAssertEqual(ReturnForm.dayString(fixedInstant(), calendar: calendar("Pacific/Auckland")), "2026-10-01")
  }

  // MARK: - 行完整判定

  func testRowStartsIncomplete() {
    let form = makeForm()
    XCTAssertFalse(form.isComplete(form.rows[0]))
    XCTAssertEqual(form.completedCount, 0)
  }

  func testAttemptedCompletionNeedsCorrect() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    XCTAssertFalse(form.isComplete(form.rows[0]), "独立做出还没选对错，不算填完")
    form.setCorrect(true, for: "itm_0")
    XCTAssertTrue(form.isComplete(form.rows[0]))
    XCTAssertEqual(form.completedCount, 1)
  }

  func testHintCompletionsAlsoNeedCorrect() {
    var form = makeForm()
    form.selectCompletion(.hint1, for: "itm_0")
    form.selectCompletion(.hint2, for: "itm_1")
    XCTAssertFalse(form.isComplete(form.rows[0]))
    XCTAssertFalse(form.isComplete(form.rows[1]))
    form.setCorrect(false, for: "itm_1")
    XCTAssertTrue(form.isComplete(form.rows[1]))
    XCTAssertFalse(form.isComplete(form.rows[0]))
  }

  func testNotSolvedIsCompleteWithoutStuckStep() {
    var form = makeForm()
    form.selectCompletion(.notSolved, for: "itm_0")
    XCTAssertTrue(form.isComplete(form.rows[0]), "没做出来时卡在哪一步可空")
  }

  func testNotDoneIsCompleteImmediately() {
    var form = makeForm()
    form.selectCompletion(.notDone, for: "itm_2")
    XCTAssertTrue(form.isComplete(form.rows[2]))
  }

  // MARK: - 切换选项清掉不再适用的字段

  func testSwitchingToNotSolvedClearsCorrect() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(true, for: "itm_0")
    form.selectCompletion(.notSolved, for: "itm_0")
    XCTAssertNil(form.rows[0].correct)
    XCTAssertTrue(form.isComplete(form.rows[0]))
  }

  func testSwitchingToNotDoneClearsCorrectAndStuckStep() {
    var form = makeForm()
    form.selectCompletion(.notSolved, for: "itm_0")
    form.setStuckStep("移项那一步", for: "itm_0")
    form.selectCompletion(.notDone, for: "itm_0")
    XCTAssertNil(form.rows[0].correct)
    XCTAssertEqual(form.rows[0].stuckStep, "")
  }

  func testSwitchingBetweenAttemptedKeepsCorrect() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(true, for: "itm_0")
    form.selectCompletion(.hint2, for: "itm_0")
    XCTAssertEqual(form.rows[0].correct, true, "前三种之间切换仍需对错，已选应保留")
  }

  // MARK: - 组装提交内容

  func testEntriesMatchReturnSpec() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(true, for: "itm_0")
    form.selectCompletion(.notSolved, for: "itm_1")
    form.setStuckStep("  移项那一步  ", for: "itm_1")
    form.selectCompletion(.notDone, for: "itm_2")
    let entries = form.entries()
    XCTAssertEqual(entries.count, 3)
    XCTAssertEqual(entries[0], V2ReturnEntry(itemId: "itm_0", completion: .independent, correct: true, performedOn: "2026-09-30", stuckStep: nil))
    XCTAssertEqual(entries[1], V2ReturnEntry(itemId: "itm_1", completion: .notSolved, correct: nil, performedOn: "2026-09-30", stuckStep: "移项那一步"))
    XCTAssertEqual(entries[2], V2ReturnEntry(itemId: "itm_2", completion: .notDone, correct: nil, performedOn: "2026-09-30", stuckStep: nil))
  }

  func testEntriesSkipIncompleteRows() {
    var form = makeForm()
    form.selectCompletion(.hint1, for: "itm_0") // 没选对错
    form.selectCompletion(.notDone, for: "itm_1")
    let entries = form.entries()
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0].itemId, "itm_1")
  }

  // MARK: - 做题日期

  func testRowDateOverridesCommonDate() {
    var form = makeForm()
    form.selectCompletion(.notDone, for: "itm_0")
    form.setPerformedOn("2026-09-29", for: "itm_0")
    form.selectCompletion(.notDone, for: "itm_1")
    let entries = form.entries()
    XCTAssertEqual(entries.first { $0.itemId == "itm_0" }?.performedOn, "2026-09-29")
    XCTAssertEqual(entries.first { $0.itemId == "itm_1" }?.performedOn, "2026-09-30")
  }

  func testFutureDateMakesRowIncomplete() {
    var form = makeForm()
    form.selectCompletion(.notDone, for: "itm_0")
    form.setPerformedOn("2026-10-01", for: "itm_0") // today 是 2026-09-30
    XCTAssertFalse(form.isComplete(form.rows[0]), "不能选未来日期")
    XCTAssertTrue(form.entries().isEmpty)
  }

  func testChangingCommonDateAffectsOnlyDefaultRows() {
    var form = makeForm()
    form.selectCompletion(.notDone, for: "itm_0")
    form.setPerformedOn("2026-09-28", for: "itm_0")
    form.selectCompletion(.notDone, for: "itm_1")
    form.setCommonDate("2026-09-29")
    let entries = form.entries()
    XCTAssertEqual(entries.first { $0.itemId == "itm_0" }?.performedOn, "2026-09-28", "单独改过的行不跟共用日期走")
    XCTAssertEqual(entries.first { $0.itemId == "itm_1" }?.performedOn, "2026-09-29")
  }

  // MARK: - 服务器逐条结果

  func testApplyResultsMovesOkRowsToRecordedAndKeepsReason() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(true, for: "itm_0")
    form.applyResults([V2ReturnResult(itemId: "itm_0", ok: true, toStatus: .temporarilyMastered, reason: "延迟 3–7 天独立做对，进入暂时掌握", error: nil)])
    XCTAssertTrue(form.rows[0].isRecorded)
    XCTAssertEqual(form.rows[0].serverReason, "延迟 3–7 天独立做对，进入暂时掌握")
    XCTAssertNil(form.rows[0].serverError)
  }

  func testApplyResultsKeepsFailedRowContentAndAttachesError() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(false, for: "itm_0")
    form.applyResults([V2ReturnResult(itemId: "itm_0", ok: false, toStatus: nil, reason: nil, error: "实际作答日期不能是未来日期")])
    XCTAssertFalse(form.rows[0].isRecorded)
    XCTAssertEqual(form.rows[0].serverError, "实际作答日期不能是未来日期")
    XCTAssertEqual(form.rows[0].completion, .independent, "学生已填内容必须保留，可改后再提交")
    XCTAssertEqual(form.rows[0].correct, false)
  }

  func testPartialSubmissionLeavesRemainingRowsUntouched() {
    var form = makeForm()
    form.selectCompletion(.independent, for: "itm_0")
    form.setCorrect(true, for: "itm_0")
    form.selectCompletion(.notSolved, for: "itm_1")
    form.setStuckStep("卡在读题", for: "itm_1")
    form.applyResults([V2ReturnResult(itemId: "itm_0", ok: true, toStatus: .temporarilyMastered, reason: "好", error: nil)])
    XCTAssertFalse(form.allRecorded)
    XCTAssertEqual(form.rows[1].stuckStep, "卡在读题")
    XCTAssertFalse(form.rows[1].isRecorded)
    // 已记录的行不再进入下一轮提交。
    XCTAssertEqual(form.entries().map(\.itemId), ["itm_1"])
  }

  func testAllRecorded() {
    var form = makeForm()
    for i in 0..<3 { form.selectCompletion(.notDone, for: "itm_\(i)") }
    form.applyResults((0..<3).map { V2ReturnResult(itemId: "itm_\($0)", ok: true, toStatus: .needsRecheck, reason: "好", error: nil) })
    XCTAssertTrue(form.allRecorded)
  }
}
