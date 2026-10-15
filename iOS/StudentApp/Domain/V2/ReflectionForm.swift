import Foundation

// 复盘确认表单（task-6p-brief §4，docs/mobile-v2-api.md §3.17–3.20、§4）。
// AI 只建议不替学生提交：建议值预选并标"AI 建议"，学生改成别的值取消标记，改回恢复；
// "现在的把握"永不预选；空归纳允许提交（服务器落最近一次 AI 归纳）。
struct ReflectionForm: Equatable {

  /// 预选值的来源标记。
  enum Mark: Equatable {
    case aiSuggestion
    case previousChoice
  }

  private(set) var summary: String = ""
  private(set) var attemptState: String?
  private(set) var cause: String?
  /// 现在的把握（0–3），永不预选。
  private(set) var masteryFeeling: Int?

  private(set) var summaryMark: Mark?
  private(set) var attemptStateMark: Mark?
  private(set) var causeMark: Mark?

  // 预选基准值：学生改走后取消标记、改回恢复标记都以此为准。
  private let baseSummary: String?
  private let baseAttemptState: String?
  private let baseCause: String?
  private let baseMark: Mark?

  static let summaryLimit = 60
  static let answerLimit = 300

  /// 选项全集：接口说明 §4 原文，不得改写。
  static let attemptStateOptions = V2ReflectionText.attemptStates
  static let causeOptions = V2ReflectionText.causes
  static let masteryOptions = V2ReflectionText.masteryFeelings

  /// 空表单（归纳失败、无建议时用）。
  init() {
    baseSummary = nil
    baseAttemptState = nil
    baseCause = nil
    baseMark = nil
  }

  /// 由 AI 建议生成：非空建议预选并标"AI 建议"。
  init(suggestionSummary: String?, suggestedCause: String?, suggestedAttemptState: String?) {
    baseSummary = suggestionSummary
    baseAttemptState = suggestedAttemptState
    baseCause = suggestedCause
    baseMark = .aiSuggestion
    if let suggestionSummary { summary = suggestionSummary; summaryMark = .aiSuggestion }
    if let suggestedAttemptState { attemptState = suggestedAttemptState; attemptStateMark = .aiSuggestion }
    if let suggestedCause { cause = suggestedCause; causeMark = .aiSuggestion }
  }

  /// 由已有复盘记录（上次的选择）生成，标"上次的选择"。把握仍不预选。
  init(record: V2ReflectionRecord) {
    baseSummary = record.summary
    baseAttemptState = record.attemptState
    baseCause = record.cause
    baseMark = .previousChoice
    if let summary0 = record.summary { summary = summary0; summaryMark = .previousChoice }
    attemptState = record.attemptState; attemptStateMark = .previousChoice
    cause = record.cause; causeMark = .previousChoice
  }

  // MARK: - 编辑

  mutating func editSummary(_ text: String) {
    summary = text
    summaryMark = ReflectionForm.mark(current: text, base: baseSummary, baseMark: baseMark)
  }

  mutating func selectAttemptState(_ value: String) {
    attemptState = value
    attemptStateMark = ReflectionForm.mark(current: value, base: baseAttemptState, baseMark: baseMark)
  }

  mutating func selectCause(_ value: String) {
    cause = value
    causeMark = ReflectionForm.mark(current: value, base: baseCause, baseMark: baseMark)
  }

  mutating func selectMasteryFeeling(_ value: Int) {
    guard (0...3).contains(value) else { return }
    masteryFeeling = value
  }

  private static func mark(current: String, base: String?, baseMark: Mark?) -> Mark? {
    guard let base, let baseMark, current == base else { return nil }
    return baseMark
  }

  // MARK: - 归纳字数（首尾空白不计）

  var trimmedSummary: String {
    summary.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var summaryLength: Int {
    trimmedSummary.count
  }

  var summaryIsValid: Bool {
    summaryLength <= ReflectionForm.summaryLimit
  }

  // MARK: - 提交判定

  var canSubmit: Bool {
    attemptState != nil && cause != nil && masteryFeeling != nil && summaryIsValid
  }

  /// "还差什么"的中文提示。
  var missingHints: [String] {
    var hints: [String] = []
    if attemptState == nil { hints.append("还没选做题状态") }
    if cause == nil { hints.append("还没选错因") }
    if masteryFeeling == nil { hints.append("还没选现在的把握") }
    if !summaryIsValid { hints.append("归纳超过 \(ReflectionForm.summaryLimit) 字了，删短一点") }
    return hints
  }

  /// 组装提交内容；不完整返回 nil。空归纳提交时缺省 summary。
  func submission() -> V2ReflectionSubmission? {
    guard canSubmit, let attemptState, let cause, let masteryFeeling else { return nil }
    let trimmed = trimmedSummary
    return V2ReflectionSubmission(
      attemptState: attemptState,
      cause: cause,
      masteryFeeling: masteryFeeling,
      summary: trimmed.isEmpty ? nil : trimmed)
  }

  // MARK: - 追问回答字数（1–300，首尾空白不计）

  static func isValidAnswer(_ text: String) -> Bool {
    let length = text.trimmingCharacters(in: .whitespacesAndNewlines).count
    return length >= 1 && length <= answerLimit
  }

  /// 剩余可写字数（可以为负，表示超出）。
  static func answerRemaining(_ text: String) -> Int {
    answerLimit - text.trimmingCharacters(in: .whitespacesAndNewlines).count
  }
}
