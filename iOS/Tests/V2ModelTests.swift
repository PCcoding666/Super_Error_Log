import XCTest
import Foundation
@testable import StudentCore

// T6a RED: /v2 模型（docs/mobile-v2-api.md 第 3、4 节）。合成文档，不连真实服务。
final class V2ModelTests: XCTestCase {
  private struct Box<T: Decodable>: Decodable { let value: T }
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try RecognitionCodec.decoder().decode(T.self, from: Data(json.utf8))
  }
  private func boxed<T: Decodable>(_ type: T.Type, _ raw: String) throws -> T {
    try decode(Box<T>.self, #"{"value":\#(raw)}"#).value
  }

  // MARK: - 常量（§4 原文）

  func testAttemptStatesAndCausesMatchSpecOriginalText() {
    XCTAssertEqual(V2ReflectionText.attemptStates,
      ["完全不会", "知道考什么但没想到方法", "方法基本正确但步骤出错", "本来会但审题计算书写失误", "时间不足", "其他"])
    XCTAssertEqual(V2ReflectionText.causes,
      ["知识概念", "方法选择", "推理步骤", "计算", "审题遗漏", "表达规范", "时间注意力状态"])
  }

  // MARK: - 枚举容忍未知取值

  func testItemStatusKeepsUnknownRawValueAndRoundTrips() throws {
    let card = try decode(V2ItemCard.self, #"{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"brand_new_state","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}"#)
    XCTAssertEqual(card.status, .unknown("brand_new_state"))
    XCTAssertEqual(card.status.rawValue, "brand_new_state")
    let reencoded = try JSONEncoder().encode(card)
    let again = try decode(V2ItemCard.self, String(decoding: reencoded, as: UTF8.self))
    XCTAssertEqual(again.status, .unknown("brand_new_state"), "未知状态编码后再解码必须保留原文")
  }

  func testKnownItemStatusAndBadgeDecodeToKnownCases() throws {
    let card = try decode(V2ItemCard.self, #"{"id":"itm_0a1b2c3d4e5f6071","shortId":null,"subject":null,"knowledgeTags":[],"questionExcerpt":null,"badge":"low","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}"#)
    XCTAssertEqual(card.status, .readyForReflection)
    XCTAssertEqual(card.badge, .low)
    XCTAssertNil(card.shortId)
    XCTAssertNil(card.subject)
    XCTAssertNil(card.questionExcerpt)
  }

  func testEveryTolerantEnumKeepsUnknownValue() throws {
    XCTAssertEqual(try boxed(V2ItemStatus.self, #""future_status""#), .unknown("future_status"))
    XCTAssertEqual(try boxed(V2ItemBadge.self, #""sparkly""#), .unknown("sparkly"))
    XCTAssertEqual(try boxed(V2PhotoRecognition.self, #""half_done""#), .unknown("half_done"))
    XCTAssertEqual(try boxed(V2PrintStatus.self, #""queued""#), .unknown("queued"))
    XCTAssertEqual(try boxed(V2PrintMode.self, #""audio""#), .unknown("audio"))
    XCTAssertEqual(try boxed(V2AnswerSource.self, #""teacher""#), .unknown("teacher"))
    XCTAssertEqual(try boxed(V2PaperLocation.self, #""office""#), .unknown("office"))
    XCTAssertEqual(try boxed(V2Completion.self, #""guessed""#), .unknown("guessed"))
    XCTAssertEqual(try boxed(V2CorrectionMethod.self, #""gesture""#), .unknown("gesture"))
    XCTAssertEqual(try boxed(V2CorrectionField.self, #""chapter""#), .unknown("chapter"))
    XCTAssertEqual(try boxed(V2ReflectionSource.self, #""parent""#), .unknown("parent"))
  }

  func testKnownEnumCasesAcrossTheBoard() throws {
    XCTAssertEqual(try boxed(V2ItemStatus.self, #""temporarily_mastered""#), .temporarilyMastered)
    XCTAssertEqual(try boxed(V2ItemStatus.self, #""archived_not_worth_review""#), .archivedNotWorthReview)
    XCTAssertEqual(try boxed(V2PhotoRecognition.self, #""done""#), .done)
    XCTAssertEqual(try boxed(V2PrintStatus.self, #""preparing""#), .preparing)
    XCTAssertEqual(try boxed(V2PrintMode.self, #""crop""#), .crop)
    XCTAssertEqual(try boxed(V2AnswerSource.self, #""paper""#), .paper)
    XCTAssertEqual(try boxed(V2PaperLocation.self, #""varies""#), .varies)
    XCTAssertEqual(try boxed(V2Completion.self, #""hint1""#), .hint1)
    XCTAssertEqual(try boxed(V2Completion.self, #""not_solved""#), .notSolved)
    XCTAssertEqual(try boxed(V2CorrectionMethod.self, #""keyboard""#), .keyboard)
    XCTAssertEqual(try boxed(V2CorrectionField.self, #""observation""#), .observation)
    XCTAssertEqual(try boxed(V2ReflectionSource.self, #""fallback""#), .fallback)
  }

  // MARK: - 日期

  func testISO8601TimestampWithMillisecondsDecodes() throws {
    let registration = try decode(V2PhotoRegistration.self,
      #"{"jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","registeredAt":"2026-09-30T08:15:00.123Z"}"#)
    XCTAssertEqual(registration.registeredAt.timeIntervalSince1970.truncatingRemainder(dividingBy: 1), 0.123, accuracy: 0.0005)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    XCTAssertEqual(registration.registeredAt, formatter.date(from: "2026-09-30T08:15:00.123Z"))
  }

  func testLocalCalendarDayStringFormatsYYYYMMDDAndRespectsTimeZone() {
    let shanghai = TimeZone(identifier: "Asia/Shanghai")!
    let utc = TimeZone(identifier: "UTC")!
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = shanghai
    let evening = calendar.date(from: DateComponents(year: 2026, month: 9, day: 30, hour: 23, minute: 30))!
    XCTAssertEqual(V2CalendarDay.string(from: evening, timeZone: shanghai), "2026-09-30")
    XCTAssertEqual(V2CalendarDay.string(from: evening, timeZone: utc), "2026-09-30")
    // 上海 10/1 00:30 在 UTC 仍是 9/30 下午：同一时刻日历日可以不同，按本地日历取。
    let pastMidnight = calendar.date(from: DateComponents(year: 2026, month: 10, day: 1, hour: 0, minute: 30))!
    XCTAssertEqual(V2CalendarDay.string(from: pastMidnight, timeZone: shanghai), "2026-10-01")
    XCTAssertEqual(V2CalendarDay.string(from: pastMidnight, timeZone: utc), "2026-09-30")
  }

  func testDateOnlyFieldsStayPlainStrings() throws {
    let summary = try decode(V2ReturnSummary.self, V2ModelTests.summaryJSON)
    XCTAssertEqual(summary.nextConfirmOn, "2026-10-10")
    // 回传入参 performedOn 原样编码为 YYYY-MM-DD 文本。
    let entry = V2ReturnEntry(itemId: "itm_0a1b2c3d4e5f6071", completion: .independent, correct: true, performedOn: "2026-10-02", stuckStep: nil)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
    XCTAssertEqual(object["performedOn"] as? String, "2026-10-02")
  }

  // MARK: - 接口示例形状（§3）

  func testWeekViewDecodesSpecExample() throws {
    let week = try decode(V2WeekView.self, V2ModelTests.weekJSON)
    XCTAssertEqual(week.week, "2026-W40")
    XCTAssertEqual(week.photos.count, 1)
    XCTAssertEqual(week.photos[0].recognition, .done)
    XCTAssertTrue(week.photos[0].bridged)
    XCTAssertNil(week.photos[0].bridgeError)
    XCTAssertEqual(week.photos[0].itemCount, 3)
    XCTAssertEqual(week.items.count, 1)
    XCTAssertEqual(week.items[0].id, "itm_0a1b2c3d4e5f6071")
    XCTAssertEqual(week.items[0].knowledgeTags, ["一元一次方程"])
    XCTAssertTrue(week.backlog.isEmpty)
  }

  func testPrintSnapshotDecodesSpecExample() throws {
    let snapshot = try decode(V2PrintSnapshot.self, V2ModelTests.snapshotJSON)
    XCTAssertEqual(snapshot.packetId, "pkt_1a2b3c4d5e6f7081")
    XCTAssertEqual(snapshot.cover.title, "本周练习")
    XCTAssertEqual(snapshot.cover.rules.count, 3)
    XCTAssertEqual(snapshot.cover.itemList[0].sourceLabel, "原题")
    XCTAssertEqual(snapshot.items[0].mode, .text)
    XCTAssertEqual(snapshot.items[0].stemText, "已知 x+y=1，求 x 的值。")
    XCTAssertNil(snapshot.items[0].cropMedia)
    XCTAssertFalse(snapshot.items[0].needsGlance)
    XCTAssertEqual(snapshot.answerSheet[0].answer.source, .ai)
    XCTAssertEqual(snapshot.answerSheet[0].answer.label, "AI 参考，未经老师核验")
    XCTAssertEqual(snapshot.answerSheet[0].fallbackNote, "对照原卷第 1 题")
  }

  func testReturnSummaryDecodesSpecExample() throws {
    let summary = try decode(V2ReturnSummary.self, V2ModelTests.summaryJSON)
    XCTAssertEqual(summary.answered, 3)
    XCTAssertEqual(summary.masteredNow[0].status, .temporarilyMastered)
    XCTAssertEqual(summary.again[0].reason, "看了提示")
    XCTAssertEqual(summary.again[0].status, .needsRecheck)
    XCTAssertEqual(summary.calibration.confidentTotal, 1)
    XCTAssertEqual(summary.calibration.text, "你说有把握的 1 道里，0 道没独立做出来")
  }

  func testReturnSummaryToleratesNullCalibrationTextAndNextConfirm() throws {
    let json = #"{"answered":0,"total":3,"independentCorrect":0,"masteredNow":[],"again":[],"calibration":{"confidentTotal":0,"missedCount":0,"text":null,"items":[]},"nextConfirmOn":null}"#
    let summary = try decode(V2ReturnSummary.self, json)
    XCTAssertNil(summary.calibration.text)
    XCTAssertNil(summary.nextConfirmOn)
  }

  // MARK: - pending 组（§3.16，T6h §4）

  func testReturnSummaryDecodesPendingGroup() throws {
    let summary = try decode(V2ReturnSummary.self, V2ModelTests.summaryJSON)
    XCTAssertEqual(summary.pending.count, 1)
    XCTAssertEqual(summary.pending[0].id, "itm_2222222222222222")
    XCTAssertEqual(summary.pending[0].status, .attempted)
    XCTAssertEqual(summary.pending[0].reason, "当天做对，隔几天再独立做对才算掌握")
  }

  func testReturnSummaryWithoutPendingFieldDecodesEmpty() throws {
    let json = #"{"answered":3,"total":3,"independentCorrect":1,"masteredNow":[],"again":[],"calibration":{"confidentTotal":0,"missedCount":0,"text":null,"items":[]},"nextConfirmOn":null}"#
    let summary = try decode(V2ReturnSummary.self, json)
    XCTAssertEqual(summary.pending, [], "旧服务器没有 pending 字段，解码为空数组")
  }

  func testCorrectionProposalDecodesChangesWithObservationAndUnknownField() throws {
    let proposal = try decode(V2CorrectionProposal.self, #"{"proposalId":"crp_a1b2c3d4e5f60718","revision":1,"changes":[{"field":"questionText","before":"已知 x+y=1，求 x 的值。","after":"已知 x+y=1，求 y 的值。","find":"x 的值","replace":"y 的值"},{"field":"observation","observationId":"o1","before":"x=1","after":"x=2"},{"field":"futureField","before":"a","after":"b"}],"clarify":null}"#)
    XCTAssertEqual(proposal.changes[0].field, .questionText)
    XCTAssertEqual(proposal.changes[0].find, "x 的值")
    XCTAssertEqual(proposal.changes[1].field, .observation)
    XCTAssertEqual(proposal.changes[1].observationId, "o1")
    XCTAssertEqual(proposal.changes[2].field, .unknown("futureField"))
    XCTAssertNil(proposal.clarify)
  }

  func testReturnEntryEncodesPerSpecAndOmitsAbsentOptionals() throws {
    let entry = V2ReturnEntry(itemId: "itm_0a1b2c3d4e5f6071", completion: .hint2, correct: false, performedOn: "2026-10-02", stuckStep: "移项那一步")
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
    XCTAssertEqual(object["itemId"] as? String, "itm_0a1b2c3d4e5f6071")
    XCTAssertEqual(object["completion"] as? String, "hint2")
    XCTAssertEqual(object["correct"] as? Bool, false)
    XCTAssertEqual(object["stuckStep"] as? String, "移项那一步")
    // 没做出来的题 correct 缺省时不编码该键（接口：只能缺省或 false）。
    let notDone = V2ReturnEntry(itemId: "itm_0a1b2c3d4e5f6071", completion: .notDone, correct: nil, performedOn: "2026-10-02", stuckStep: nil)
    let bare = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(notDone)) as? [String: Any])
    XCTAssertNil(bare["correct"])
    XCTAssertNil(bare["stuckStep"])
    XCTAssertEqual(bare["completion"] as? String, "not_done")
  }

  func testCorrectionChangeEncodesWithoutAbsentOptionals() throws {
    let change = V2CorrectionChange(field: .subject, observationId: nil, before: "数学", after: "物理", find: nil, replace: nil)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(change)) as? [String: Any])
    XCTAssertEqual(object["field"] as? String, "subject")
    XCTAssertEqual(object["before"] as? String, "数学")
    XCTAssertNil(object["observationId"])
    XCTAssertNil(object["find"])
  }

  // MARK: - 夹具（接口说明原文示例）

  static let weekJSON = #"{"week":"2026-W40","photos":[{"jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","registeredAt":"2026-09-30T08:15:00.123Z","recognition":"done","bridged":true,"bridgeError":null,"itemCount":3}],"items":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}],"backlog":[]}"#

  static let snapshotJSON = #"{"packetId":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","preparedAt":"2026-09-30T08:21:00.000Z","cover":{"title":"本周练习","practiceSlot":"周三晚自习","rules":["不看答案，独立做","卡住先看一级提示，再看二级","做完打勾，写上做题日期"],"itemList":[{"shortId":"M-12","sourceLabel":"原题"}]},"items":[{"itemId":"itm_0a1b2c3d4e5f6071","shortId":"M-12","position":0,"subject":"数学","knowledgeTags":["一元一次方程"],"mode":"text","stemText":"已知 x+y=1，求 x 的值。","cropMedia":null,"diagramMedia":[],"keyStepPrompt":"这题的关键一步是：","checkboxes":["独立做出","看了一级提示","看了二级提示","没做出来"],"needsGlance":false,"glanceReason":null}],"answerSheet":[{"shortId":"M-12","hint1":"一级提示：先移项","hint2":"二级提示：两边同时减 y","answer":{"text":"x = 1 - y","source":"ai","label":"AI 参考，未经老师核验"},"fallbackNote":"对照原卷第 1 题"}]}"#

  static let summaryJSON = #"{"answered":3,"total":3,"independentCorrect":1,"masteredNow":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"temporarily_mastered","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}],"again":[{"id":"itm_1111111111111111","shortId":"M-13","subject":"数学","knowledgeTags":["分式"],"questionExcerpt":"…","badge":"ok","status":"needs_recheck","cropUrl":"/v2/items/itm_1111111111111111/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"看了提示"}],"pending":[{"id":"itm_2222222222222222","shortId":"M-14","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"…","badge":"ok","status":"attempted","cropUrl":"/v2/items/itm_2222222222222222/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"当天做对，隔几天再独立做对才算掌握"}],"calibration":{"confidentTotal":1,"missedCount":0,"text":"你说有把握的 1 道里，0 道没独立做出来","items":[]},"nextConfirmOn":"2026-10-10"}"#
}
