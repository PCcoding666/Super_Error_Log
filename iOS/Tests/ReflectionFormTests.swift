import XCTest
import Foundation
@testable import StudentCore

// T6p RED: 复盘确认表单规则（task-6p-brief §4，docs/mobile-v2-api.md §3.17–3.20、§4）。
final class ReflectionFormTests: XCTestCase {

  private func makeRecord(summary: String = "上次归纳", attemptState: String = "完全不会", cause: String = "计算", mastery: Int = 2) -> V2ReflectionRecord {
    V2ReflectionRecord(id: "dia_1", attemptState: attemptState, cause: cause, masteryFeeling: mastery,
                       summary: summary, adoptedAi: false, source: "v2",
                       createdAt: Date(timeIntervalSince1970: 1_759_000_000), status: .eligibleForReview)
  }

  // MARK: - 选项全集用 §4 原文

  func testOptionSetsMatchSpecOriginalText() {
    XCTAssertEqual(ReflectionForm.attemptStateOptions, V2ReflectionText.attemptStates)
    XCTAssertEqual(ReflectionForm.attemptStateOptions.count, 6)
    XCTAssertEqual(ReflectionForm.causeOptions, V2ReflectionText.causes)
    XCTAssertEqual(ReflectionForm.causeOptions.count, 7)
    XCTAssertEqual(ReflectionForm.masteryOptions, V2ReflectionText.masteryFeelings)
    XCTAssertEqual(ReflectionForm.masteryOptions.count, 4)
  }

  // MARK: - 由 AI 建议生成

  func testSuggestionPreselectsAndMarksAI() {
    let form = ReflectionForm(suggestionSummary: "把移项当成了照抄", suggestedCause: "推理步骤", suggestedAttemptState: "方法基本正确但步骤出错")
    XCTAssertEqual(form.summary, "把移项当成了照抄")
    XCTAssertEqual(form.cause, "推理步骤")
    XCTAssertEqual(form.attemptState, "方法基本正确但步骤出错")
    XCTAssertEqual(form.summaryMark, .aiSuggestion)
    XCTAssertEqual(form.causeMark, .aiSuggestion)
    XCTAssertEqual(form.attemptStateMark, .aiSuggestion)
  }

  func testSuggestionWithNullsLeavesFieldsEmptyAndUnmarked() {
    let form = ReflectionForm(suggestionSummary: nil, suggestedCause: nil, suggestedAttemptState: nil)
    XCTAssertEqual(form.summary, "")
    XCTAssertNil(form.cause)
    XCTAssertNil(form.attemptState)
    XCTAssertNil(form.summaryMark)
    XCTAssertNil(form.causeMark)
    XCTAssertNil(form.attemptStateMark)
  }

  func testMasteryFeelingIsNeverPreselected() {
    let fromAI = ReflectionForm(suggestionSummary: "s", suggestedCause: "计算", suggestedAttemptState: "其他")
    XCTAssertNil(fromAI.masteryFeeling)
    let fromRecord = ReflectionForm(record: makeRecord(mastery: 3))
    XCTAssertNil(fromRecord.masteryFeeling, "把握永远不建议、不预选，即使有上次记录")
  }

  func testEditingAwayClearsMarkAndEditingBackRestoresIt() {
    var form = ReflectionForm(suggestionSummary: "把移项当成了照抄", suggestedCause: "推理步骤", suggestedAttemptState: nil)
    form.selectCause("计算")
    XCTAssertEqual(form.cause, "计算")
    XCTAssertNil(form.causeMark, "改成别的值后不再是 AI 建议")
    form.selectCause("推理步骤")
    XCTAssertEqual(form.causeMark, .aiSuggestion, "改回建议值恢复标记")

    form.editSummary("我自己的归纳")
    XCTAssertNil(form.summaryMark)
    form.editSummary("把移项当成了照抄")
    XCTAssertEqual(form.summaryMark, .aiSuggestion)
  }

  // MARK: - 由已有复盘记录生成

  func testRecordInitPreselectsAndMarksPreviousChoice() {
    let form = ReflectionForm(record: makeRecord())
    XCTAssertEqual(form.summary, "上次归纳")
    XCTAssertEqual(form.attemptState, "完全不会")
    XCTAssertEqual(form.cause, "计算")
    XCTAssertEqual(form.summaryMark, .previousChoice)
    XCTAssertEqual(form.attemptStateMark, .previousChoice)
    XCTAssertEqual(form.causeMark, .previousChoice)
  }

  func testRecordInitEditAwayAndBackRestoresPreviousMark() {
    var form = ReflectionForm(record: makeRecord())
    form.selectAttemptState("时间不足")
    XCTAssertNil(form.attemptStateMark)
    form.selectAttemptState("完全不会")
    XCTAssertEqual(form.attemptStateMark, .previousChoice)
  }

  // MARK: - 归纳字数

  func testSummaryLimitCountsTrimmedCharacters() {
    var form = ReflectionForm()
    form.editSummary("  " + String(repeating: "字", count: 60) + "  ")
    XCTAssertEqual(form.summaryLength, 60, "首尾空白不计")
    XCTAssertTrue(form.summaryIsValid)
    form.editSummary(String(repeating: "字", count: 61))
    XCTAssertFalse(form.summaryIsValid)
  }

  func testEmptySummaryIsSubmittableAndOmittedInSubmission() {
    var form = ReflectionForm(suggestionSummary: nil, suggestedCause: nil, suggestedAttemptState: nil)
    form.editSummary("   ")
    form.selectAttemptState("完全不会")
    form.selectCause("计算")
    form.selectMasteryFeeling(1)
    XCTAssertTrue(form.canSubmit, "空归纳允许提交（服务器会用最近一次 AI 归纳）")
    XCTAssertNil(form.submission()?.summary)
  }

  func testTooLongSummaryBlocksSubmission() {
    var form = ReflectionForm(suggestionSummary: nil, suggestedCause: nil, suggestedAttemptState: nil)
    form.selectAttemptState("完全不会")
    form.selectCause("计算")
    form.selectMasteryFeeling(0)
    form.editSummary(String(repeating: "长", count: 61))
    XCTAssertFalse(form.canSubmit)
    XCTAssertNil(form.submission())
  }

  // MARK: - 可提交判定与"还差什么"

  func testCanSubmitNeedsAllThreeSelections() {
    var form = ReflectionForm(suggestionSummary: "s", suggestedCause: "计算", suggestedAttemptState: "其他")
    XCTAssertFalse(form.canSubmit, "把握未选")
    form.selectMasteryFeeling(2)
    XCTAssertTrue(form.canSubmit)
  }

  func testMissingHintsAreChineseAndSpecific() {
    let form = ReflectionForm()
    XCTAssertEqual(form.missingHints, ["还没选做题状态", "还没选错因", "还没选现在的把握"])
  }

  func testMissingHintsShrinkAsFieldsAreFilled() {
    var form = ReflectionForm()
    form.selectAttemptState("完全不会")
    form.selectCause("计算")
    XCTAssertEqual(form.missingHints, ["还没选现在的把握"])
    form.selectMasteryFeeling(3)
    XCTAssertTrue(form.missingHints.isEmpty)
    form.editSummary(String(repeating: "字", count: 61))
    XCTAssertEqual(form.missingHints, ["归纳超过 60 字了，删短一点"])
  }

  // MARK: - 提交内容

  func testSubmissionMatchesSpecShape() {
    var form = ReflectionForm(suggestionSummary: nil, suggestedCause: nil, suggestedAttemptState: nil)
    form.selectAttemptState("本来会但审题计算书写失误")
    form.selectCause("审题遗漏")
    form.selectMasteryFeeling(3)
    form.editSummary("  没看清是求 y  ")
    let submission = form.submission()
    XCTAssertEqual(submission, V2ReflectionSubmission(attemptState: "本来会但审题计算书写失误", cause: "审题遗漏", masteryFeeling: 3, summary: "没看清是求 y"))
  }

  // MARK: - 追问回答字数

  func testAnswerValidationTrimsAndBounds() {
    XCTAssertFalse(ReflectionForm.isValidAnswer(""))
    XCTAssertFalse(ReflectionForm.isValidAnswer("   "))
    XCTAssertTrue(ReflectionForm.isValidAnswer("一"))
    XCTAssertTrue(ReflectionForm.isValidAnswer(String(repeating: "字", count: 300)))
    XCTAssertFalse(ReflectionForm.isValidAnswer(String(repeating: "字", count: 301)))
  }

  func testAnswerRemainingCountsDownFromTrimmedLength() {
    XCTAssertEqual(ReflectionForm.answerRemaining(""), 300)
    XCTAssertEqual(ReflectionForm.answerRemaining("  abc  "), 297)
    XCTAssertEqual(ReflectionForm.answerRemaining(String(repeating: "字", count: 300)), 0)
    XCTAssertEqual(ReflectionForm.answerRemaining(String(repeating: "字", count: 305)), -5)
  }
}
