import Foundation

// 练习卡的状态句与下一步（task-6p-brief §5）。
// "已打印"的判定：generatedAt != nil；没复盘完也允许打印，状态句里提示。
enum PracticeCardText {

  enum NextStep: Equatable, CaseIterable {
    case reflect, print, reprint, record, viewSummary

    var title: String {
      switch self {
      case .reflect: "去复盘"
      case .print: "打印练习纸"
      case .reprint: "再打印一份"
      case .record: "录结果"
      case .viewSummary: "看结果"
      }
    }
  }

  struct Content: Equatable {
    let statusLine: String
    let steps: [NextStep]
    /// 能否开始下一份：已打印（含已录一部分、已录完）时可以；还没打印时不可以。
    let canPickNext: Bool
    /// 当前练习是否已录完（决定「选下一份」是主要还是次要按钮）。
    let allRecorded: Bool
  }

  static func make(detail: V2PracticeDetail, summary: V2ReturnSummary?) -> Content {
    let total = detail.items.count
    let unreflected = detail.items.filter { !$0.reflected }.count
    let printed = detail.generatedAt != nil
    let answered = summary?.answered ?? 0
    let allRecorded = printed && total > 0 && answered >= total

    var parts = ["\(total) 道题"]
    if let slot = detail.practiceSlot, !slot.isEmpty { parts.append(slot) }

    var steps: [NextStep] = []
    if !printed {
      if unreflected > 0 { parts.append("还有 \(unreflected) 道没复盘") }
      parts.append("还没打印")
      if unreflected > 0 { steps.append(.reflect) }
      steps.append(.print)
    } else if !allRecorded {
      parts.append(answered == 0 ? "已打印，做完回来录结果" : "已录 \(answered)/\(total) 道")
      steps.append(.record)
      steps.append(.reprint)
      if answered >= 1 { steps.append(.viewSummary) }
    } else {
      parts.append("已录完")
      steps.append(.viewSummary)
      steps.append(.reprint)
    }

    return Content(statusLine: parts.joined(separator: " · "), steps: steps,
      canPickNext: printed, allRecorded: allRecorded)
  }

  /// 「更早的练习」折叠区的一行：周 · 做题时段 · 几道题 · 一句状态（T6h §2）。
  static func olderLine(_ practice: V2PracticeSummary) -> String {
    var parts = [practice.week]
    if let slot = practice.practiceSlot, !slot.isEmpty { parts.append(slot) }
    parts.append("\(practice.itemCount) 道题")
    parts.append(practice.generatedAt == nil ? "还没打印" : "已打印")
    return parts.joined(separator: " · ")
  }
}
