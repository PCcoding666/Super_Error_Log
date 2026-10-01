import Foundation

// 录结果表单（task-6p-brief §3，docs/mobile-v2-api.md §3.15）。
// 纯值类型：每题一行，五选一完成情况；前三种必须再选"对了/错了"；
// "没做出来"可填"卡在哪一步"；日期默认取表单共用日期，可单独改；不能选未来日期。
struct ReturnForm: Equatable {

  struct Row: Equatable, Identifiable {
    let itemId: String
    let shortId: String?
    let subject: String?
    var completion: V2Completion?
    var correct: Bool?
    var stuckStep: String = ""
    /// 单独改过的做题日期（YYYY-MM-DD）；nil 表示用表单共用日期。
    var performedOn: String?
    /// 服务器 ok:true 后移入"已记录"，并保存服务器给的一句结果。
    var isRecorded = false
    var serverReason: String?
    /// 服务器 ok:false 时留下并带原因，学生可改后再提交。
    var serverError: String?

    var id: String { itemId }
  }

  private(set) var rows: [Row]
  /// 表单顶部共用日期（YYYY-MM-DD），默认取"今天"的本机日历日。
  private(set) var commonDate: String
  /// 注入的"今天"（YYYY-MM-DD），用于拒绝未来日期。
  let today: String

  init(detail: V2PracticeDetail, today: Date, calendar: Calendar) {
    let todayString = ReturnForm.dayString(today, calendar: calendar)
    self.today = todayString
    self.commonDate = todayString
    self.rows = detail.items
      .sorted { $0.position < $1.position }
      .map { Row(itemId: $0.id, shortId: $0.shortId, subject: $0.subject) }
  }

  /// 本机日历日 → YYYY-MM-DD。
  static func dayString(_ date: Date, calendar: Calendar) -> String {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    guard let year = components.year, let month = components.month, let day = components.day else { return "" }
    return String(format: "%04d-%02d-%02d", year, month, day)
  }

  // MARK: - 编辑

  /// 切换完成情况时清掉不再适用的字段：
  /// 选前三种（要选对错）清掉"卡在哪一步"；选"没做出来"清掉"对了/错了"；选"没做"两者都清。
  mutating func selectCompletion(_ completion: V2Completion, for itemId: String) {
    guard let index = rows.firstIndex(where: { $0.itemId == itemId }) else { return }
    rows[index].completion = completion
    switch completion {
    case .independent, .hint1, .hint2:
      rows[index].stuckStep = ""
    case .notSolved:
      rows[index].correct = nil
    case .notDone:
      rows[index].correct = nil
      rows[index].stuckStep = ""
    case .unknown:
      rows[index].correct = nil
      rows[index].stuckStep = ""
    }
  }

  mutating func setCorrect(_ correct: Bool, for itemId: String) {
    guard let index = rows.firstIndex(where: { $0.itemId == itemId }) else { return }
    rows[index].correct = correct
  }

  mutating func setStuckStep(_ text: String, for itemId: String) {
    guard let index = rows.firstIndex(where: { $0.itemId == itemId }) else { return }
    rows[index].stuckStep = text
  }

  /// 单独改某行日期；传 nil 恢复跟随共用日期。
  mutating func setPerformedOn(_ date: String?, for itemId: String) {
    guard let index = rows.firstIndex(where: { $0.itemId == itemId }) else { return }
    rows[index].performedOn = date
  }

  mutating func setCommonDate(_ date: String) {
    commonDate = date
  }

  // MARK: - 判定

  func resolvedDate(_ row: Row) -> String? {
    let date = row.performedOn ?? commonDate
    return date.isEmpty ? nil : date
  }

  func isFutureDate(_ date: String) -> Bool {
    date > today
  }

  /// 一行是否填完整：选了完成情况、日期有效且不是未来日期、前三种已选对错。
  func isComplete(_ row: Row) -> Bool {
    guard let completion = row.completion else { return false }
    guard let date = resolvedDate(row), ReturnForm.isDayString(date), !isFutureDate(date) else { return false }
    switch completion {
    case .independent, .hint1, .hint2:
      return row.correct != nil
    case .notSolved, .notDone:
      return true
    case .unknown:
      return false
    }
  }

  /// 已填完整（且未记录）的行数。
  var completedCount: Int {
    rows.filter { isComplete($0) && !$0.isRecorded }.count
  }

  var allRecorded: Bool {
    rows.allSatisfy(\.isRecorded)
  }

  // MARK: - 提交

  /// 组装提交内容：已填完整且未记录的行。前三种带 correct，后两种不带；stuckStep 去首尾空白，空则缺省。
  func entries() -> [V2ReturnEntry] {
    rows.compactMap { row in
      guard !row.isRecorded, isComplete(row), let completion = row.completion, let date = resolvedDate(row) else { return nil }
      let needsCorrect: Bool
      switch completion {
      case .independent, .hint1, .hint2: needsCorrect = true
      default: needsCorrect = false
      }
      let stuck = row.stuckStep.trimmingCharacters(in: .whitespacesAndNewlines)
      return V2ReturnEntry(
        itemId: row.itemId,
        completion: completion,
        correct: needsCorrect ? row.correct : nil,
        performedOn: date,
        stuckStep: completion == .notSolved && !stuck.isEmpty ? stuck : nil)
    }
  }

  /// 应用服务器逐条结果：ok 的行移入"已记录"并保存结果句；被拒的行留下学生已填内容并带原因。
  mutating func applyResults(_ results: [V2ReturnResult]) {
    for result in results {
      guard let index = rows.firstIndex(where: { $0.itemId == result.itemId }) else { continue }
      if result.ok {
        rows[index].isRecorded = true
        rows[index].serverReason = result.reason
        rows[index].serverError = nil
      } else {
        rows[index].serverError = result.error
      }
    }
  }

  private static func isDayString(_ text: String) -> Bool {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return false }
    guard parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return false }
    return parts.allSatisfy { $0.allSatisfy(\.isNumber) }
  }
}
