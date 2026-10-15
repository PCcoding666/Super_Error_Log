import Foundation

// /v2 枚举（docs/mobile-v2-api.md §4）。服务器以后新增取值时客户端不得解码失败：
// 一律落到 unknown(原文)，编码时原样写回。

/// 题目状态（§4 ItemStatus）。
enum V2ItemStatus: Equatable, Sendable {
  case captured, needsReview, readyForReflection, eligibleForReview, scheduled
  case packetGenerated, attempted, needsRecheck, temporarilyMastered, stablyMastered
  case archivedNotWorthReview
  case unknown(String)

  init(rawValue: String) {
    switch rawValue {
    case "captured": self = .captured
    case "needs_review": self = .needsReview
    case "ready_for_reflection": self = .readyForReflection
    case "eligible_for_review": self = .eligibleForReview
    case "scheduled": self = .scheduled
    case "packet_generated": self = .packetGenerated
    case "attempted": self = .attempted
    case "needs_recheck": self = .needsRecheck
    case "temporarily_mastered": self = .temporarilyMastered
    case "stably_mastered": self = .stablyMastered
    case "archived_not_worth_review": self = .archivedNotWorthReview
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .captured: "captured"
    case .needsReview: "needs_review"
    case .readyForReflection: "ready_for_reflection"
    case .eligibleForReview: "eligible_for_review"
    case .scheduled: "scheduled"
    case .packetGenerated: "packet_generated"
    case .attempted: "attempted"
    case .needsRecheck: "needs_recheck"
    case .temporarilyMastered: "temporarily_mastered"
    case .stablyMastered: "stably_mastered"
    case .archivedNotWorthReview: "archived_not_worth_review"
    case .unknown(let value): value
    }
  }
}

/// 识别徽标：ok / low（没把握，打印时印遮白裁图）。
enum V2ItemBadge: Equatable, Sendable {
  case ok, low, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "ok": self = .ok
    case "low": self = .low
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .ok: "ok"
    case .low: "low"
    case .unknown(let value): value
    }
  }
}

/// /v2/week 照片行的识别状态。
enum V2PhotoRecognition: Equatable, Sendable {
  case processing, done, failed, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "processing": self = .processing
    case "done": self = .done
    case "failed": self = .failed
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .processing: "processing"
    case .done: "done"
    case .failed: "failed"
    case .unknown(let value): value
    }
  }
}

/// 打印快照状态。
enum V2PrintStatus: Equatable, Sendable {
  case none, preparing, ready, failed, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "none": self = .none
    case "preparing": self = .preparing
    case "ready": self = .ready
    case "failed": self = .failed
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .none: "none"
    case .preparing: "preparing"
    case .ready: "ready"
    case .failed: "failed"
    case .unknown(let value): value
    }
  }
}

/// 快照题面模式：text 印转写文字；crop 印遮白裁图。
enum V2PrintMode: Equatable, Sendable {
  case text, crop, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "text": self = .text
    case "crop": self = .crop
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .text: "text"
    case .crop: "crop"
    case .unknown(let value): value
    }
  }
}

/// 答案页答案来源。
enum V2AnswerSource: Equatable, Sendable {
  case paper, ai, none, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "paper": self = .paper
    case "ai": self = .ai
    case "none": self = .none
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .paper: "paper"
    case .ai: "ai"
    case .none: "none"
    case .unknown(let value): value
    }
  }
}

/// 原卷通常在哪。
enum V2PaperLocation: Equatable, Sendable {
  case school, home, varies, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "school": self = .school
    case "home": self = .home
    case "varies": self = .varies
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .school: "school"
    case .home: "home"
    case .varies: "varies"
    case .unknown(let value): value
    }
  }
}

/// 回传 completion 五取值（§4 表）。
enum V2Completion: Equatable, Sendable {
  case independent, hint1, hint2, notSolved, notDone, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "independent": self = .independent
    case "hint1": self = .hint1
    case "hint2": self = .hint2
    case "not_solved": self = .notSolved
    case "not_done": self = .notDone
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .independent: "independent"
    case .hint1: "hint1"
    case .hint2: "hint2"
    case .notSolved: "not_solved"
    case .notDone: "not_done"
    case .unknown(let value): value
    }
  }
}

/// 修改方式：voice / keyboard（直改落库为 direct，仅请求用）。
enum V2CorrectionMethod: Equatable, Sendable {
  case voice, keyboard, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "voice": self = .voice
    case "keyboard": self = .keyboard
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .voice: "voice"
    case .keyboard: "keyboard"
    case .unknown(let value): value
    }
  }
}

/// 修改字段（observation 时另带 observationId）。
enum V2CorrectionField: Equatable, Sendable {
  case questionText, observation, subject, knowledgeTags, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "questionText": self = .questionText
    case "observation": self = .observation
    case "subject": self = .subject
    case "knowledgeTags": self = .knowledgeTags
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .questionText: "questionText"
    case .observation: "observation"
    case .subject: "subject"
    case .knowledgeTags: "knowledgeTags"
    case .unknown(let value): value
    }
  }
}

/// 追问来源：ai（模型出题）/ fallback（固定开放句）。
enum V2ReflectionSource: Equatable, Sendable {
  case ai, fallback, unknown(String)
  init(rawValue: String) {
    switch rawValue {
    case "ai": self = .ai
    case "fallback": self = .fallback
    default: self = .unknown(rawValue)
    }
  }
  var rawValue: String {
    switch self {
    case .ai: "ai"
    case .fallback: "fallback"
    case .unknown(let value): value
    }
  }
}

// 每个枚举同一种 Codable 实现：按原文解码，未知值进 unknown，编码写回原文。
extension V2ItemStatus: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2ItemBadge: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2PhotoRecognition: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2PrintStatus: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2PrintMode: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2AnswerSource: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2PaperLocation: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2Completion: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2CorrectionMethod: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2CorrectionField: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}
extension V2ReflectionSource: Codable {
  init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer(); try container.encode(rawValue)
  }
}

/// §4 原文常量：提交复盘时必须原样发回，不得在客户端改写。
enum V2ReflectionText {
  /// 做题状态 ATTEMPT_STATES（原文）。
  static let attemptStates = ["完全不会", "知道考什么但没想到方法", "方法基本正确但步骤出错", "本来会但审题计算书写失误", "时间不足", "其他"]
  /// 错因 CAUSES（原文）。
  static let causes = ["知识概念", "方法选择", "推理步骤", "计算", "审题遗漏", "表达规范", "时间注意力状态"]
  /// 把握程度 0–3 的展示文案（下标即 masteryFeeling 值）。
  static let masteryFeelings = ["仍不会", "看提示可能会", "现在重做应该会", "隔几天也有把握"]
}

/// performedOn / nextConfirmOn 这类"只有日期"的字段保持 YYYY-MM-DD 文本；
/// 需要按本地日历日从 Date 生成该文本时用这里。
enum V2CalendarDay {
  static func string(from date: Date, timeZone: TimeZone = .current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    guard let year = components.year, let month = components.month, let day = components.day else {
      return ""
    }
    return String(format: "%04d-%02d-%02d", year, month, day)
  }
}
