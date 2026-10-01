import Foundation

// /v2 推荐、练习、打印、回传、回报（docs/mobile-v2-api.md §3.8–3.16）。

/// 推荐卡片：题卡片 + 推荐层级与理由（§3.8）。
struct V2RecommendedItem: Codable, Equatable, Sendable {
  let id: String
  let shortId: String?
  let subject: String?
  let knowledgeTags: [String]
  let questionExcerpt: String?
  let badge: V2ItemBadge
  let status: V2ItemStatus
  let cropUrl: String
  let jobId: String
  let reason: String
  let tier: Int
  let reflected: Bool
}

/// GET /v2/practice/recommend 响应。
struct V2Recommendation: Codable, Equatable, Sendable {
  struct Limits: Codable, Equatable, Sendable {
    let min: Int
    let max: Int
  }
  let recommended: [V2RecommendedItem]
  let others: [V2RecommendedItem]
  let notes: [String]
  let limits: Limits
}

/// POST /v2/practice 请求正文（practiceSlot 缺省用学生设置）。
struct V2PracticeCreateRequest: Encodable, Equatable, Sendable {
  let itemIds: [String]
  let practiceSlot: String?
}

/// 练习包摘要（GET /v2/practice 列表项）。
struct V2PracticeSummary: Codable, Equatable, Sendable {
  let id: String
  let week: String
  let status: String
  let practiceSlot: String?
  let createdAt: Date
  let generatedAt: Date?
  let itemCount: Int
}

/// GET /v2/practice 响应包装。
struct V2PracticeList: Codable, Equatable, Sendable {
  let packets: [V2PracticeSummary]
}

/// 练习详情里的题：推荐卡片 + position（建包时冻结）。
struct V2PracticeItem: Codable, Equatable, Sendable {
  let id: String
  let shortId: String?
  let subject: String?
  let knowledgeTags: [String]
  let questionExcerpt: String?
  let badge: V2ItemBadge
  let status: V2ItemStatus
  let cropUrl: String
  let jobId: String
  let reason: String
  let tier: Int
  let reflected: Bool
  let position: Int
}

/// POST /v2/practice 与 GET /v2/practice/:id 的响应。
struct V2PracticeDetail: Codable, Equatable, Sendable {
  let id: String
  let week: String
  let status: String
  let practiceSlot: String?
  let createdAt: Date
  let generatedAt: Date?
  let items: [V2PracticeItem]
}

// MARK: - 打印快照（§3.12–3.14）

struct V2PrintProgress: Codable, Equatable, Sendable {
  let done: Int
  let total: Int
}

/// POST/GET /v2/practice/:id/print 的统一响应形状：
/// status 必有；preparing 可带 progress；failed 带 error；ready 带 snapshot。
struct V2PrintState: Codable, Equatable, Sendable {
  let status: V2PrintStatus
  let progress: V2PrintProgress?
  let error: String?
  let snapshot: V2PrintSnapshot?
}

struct V2PrintCoverItem: Codable, Equatable, Sendable {
  let shortId: String?
  let sourceLabel: String
}

struct V2PrintCover: Codable, Equatable, Sendable {
  let title: String
  let practiceSlot: String
  let rules: [String]
  let itemList: [V2PrintCoverItem]
}

/// 快照题面：mode text 印 stemText（另可带 diagramMedia）；crop 印遮白裁图 cropMedia。
struct V2PrintItem: Codable, Equatable, Sendable {
  let itemId: String
  let shortId: String?
  let position: Int
  let subject: String?
  let knowledgeTags: [String]
  let mode: V2PrintMode
  let stemText: String?
  let cropMedia: String?
  let diagramMedia: [String]
  let keyStepPrompt: String
  let checkboxes: [String]
  /// true 时打印前提示学生看一眼原图（遮白可能不全）。
  let needsGlance: Bool
  let glanceReason: String?
}

struct V2PrintAnswerBody: Codable, Equatable, Sendable {
  let text: String?
  let source: V2AnswerSource
  let label: String?
}

struct V2PrintAnswerEntry: Codable, Equatable, Sendable {
  let shortId: String?
  let hint1: String?
  let hint2: String?
  let answer: V2PrintAnswerBody
  let fallbackNote: String
}

/// 打印快照：手机据此排版生成 PDF（§3.13）。
struct V2PrintSnapshot: Codable, Equatable, Sendable {
  let packetId: String
  let week: String
  let preparedAt: Date
  let cover: V2PrintCover
  let items: [V2PrintItem]
  let answerSheet: [V2PrintAnswerEntry]
}

// MARK: - 回传（§3.15）与回报（§3.16）

/// 回传逐条入参。performedOn 是纸上实际作答的本地日历日（YYYY-MM-DD）。
/// independent/hint1/hint2 必须给 correct；not_solved/not_done 缺省或 false。
struct V2ReturnEntry: Encodable, Equatable, Sendable {
  let itemId: String
  let completion: V2Completion
  let correct: Bool?
  let performedOn: String
  let stuckStep: String?
}

/// POST /v2/practice/:id/return 请求正文包装。
struct V2ReturnRequest: Encodable, Equatable, Sendable {
  let results: [V2ReturnEntry]
}

/// 回传逐条结果：ok 时带 toStatus/reason，被拒时带中文 error。
struct V2ReturnResult: Codable, Equatable, Sendable {
  let itemId: String
  let ok: Bool
  let toStatus: V2ItemStatus?
  let reason: String?
  let error: String?
}

struct V2ReturnResponse: Codable, Equatable, Sendable {
  let results: [V2ReturnResult]
}

/// 回报里"再来一次"的题卡片 + 原因。
struct V2AgainItem: Codable, Equatable, Sendable {
  let id: String
  let shortId: String?
  let subject: String?
  let knowledgeTags: [String]
  let questionExcerpt: String?
  let badge: V2ItemBadge
  let status: V2ItemStatus
  let cropUrl: String
  let jobId: String
  let reason: String
}

/// 校准统计：基数为 0 时 text 为 null。
struct V2Calibration: Codable, Equatable, Sendable {
  let confidentTotal: Int
  let missedCount: Int
  let text: String?
  let items: [V2ItemCard]
}

/// GET /v2/practice/:id/summary 响应。nextConfirmOn 仅日期 YYYY-MM-DD。
struct V2ReturnSummary: Codable, Equatable, Sendable {
  let answered: Int
  let total: Int
  let independentCorrect: Int
  let masteredNow: [V2ItemCard]
  let again: [V2AgainItem]
  let calibration: V2Calibration
  let nextConfirmOn: String?
}
