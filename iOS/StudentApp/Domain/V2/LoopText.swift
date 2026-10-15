import Foundation

// T6c：主页与修改面板的学生可见文案（纯逻辑）。
// 文案中文、直白；未知状态不猜，显示「状态更新中」。

enum LoopText {
  /// 题目状态 → 学生看得懂的一句话（服务器状态名不变，只是显示）。
  static func itemStatus(_ status: V2ItemStatus) -> String {
    switch status {
    case .readyForReflection: "还没说为什么错"
    case .eligibleForReview: "说过了"
    case .scheduled: "已排进本周练习"
    case .packetGenerated: "在练习纸上"
    case .attempted: "上次当场做对，隔几天再验证"
    case .needsRecheck: "上次没独立做对，要再练"
    case .temporarilyMastered: "真会了（还要再确认一次）"
    case .stablyMastered: "稳了"
    case .archivedNotWorthReview: "已移出"
    case .captured, .needsReview, .unknown: "状态更新中"
    }
  }

  /// 观察记录种类 → 展示名（evidence 的 observations[].kind）。
  static func observationKind(_ kind: String) -> String {
    switch kind {
    case "student_work": "你的作答"
    case "correction": "订正"
    case "teacher_note": "老师批注"
    case "reference_answer": "参考答案"
    default: "识别记录"
    }
  }

  /// 主页错题卡上的状态句：卡片不显示「还没说为什么错」「说过了」这类流程状态（设计稿 §5，
  /// 卡片上没有对应入口，只在详情里说）；其余同 itemStatus。
  static func cardStatus(_ status: V2ItemStatus) -> String? {
    switch status {
    case .readyForReflection, .eligibleForReview: nil
    default: itemStatus(status)
    }
  }

  /// 「不是错题」按钮是否显示：只有「还没说为什么错」「说过了」能移出（服务器规则）。
  static func canDiscard(_ status: V2ItemStatus) -> Bool {
    switch status {
    case .readyForReflection, .eligibleForReview: true
    default: false
    }
  }
}
