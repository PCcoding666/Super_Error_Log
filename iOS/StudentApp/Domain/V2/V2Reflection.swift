import Foundation

// /v2 追问与复盘（docs/mobile-v2-api.md §3.17–3.20）。

/// POST /v2/items/:id/reflection/ask 响应。
struct V2ReflectionQuestion: Codable, Equatable, Sendable {
  let turn: Int
  let question: String
  let source: V2ReflectionSource
}

/// POST /v2/items/:id/reflection/answer 请求正文。
struct V2ReflectionAnswerRequest: Encodable, Equatable, Sendable {
  let answer: String
}

/// POST /v2/items/:id/reflection/answer 响应：归纳失败时三个建议字段为 null。
struct V2ReflectionAnswerResult: Codable, Equatable, Sendable {
  let turn: Int
  let summary: String?
  let suggestedCause: String?
  let suggestedAttemptState: String?
  let secondQuestion: String?
}

/// POST /v2/items/:id/reflection 请求正文：全部由学生确认；summary 缺省时服务器落最近一次 AI 归纳。
struct V2ReflectionSubmission: Encodable, Equatable, Sendable {
  let attemptState: String
  let cause: String
  let masteryFeeling: Int
  let summary: String?
}

/// 复盘记录。提交响应（§3.19）带 status；详情（§3.20）里的 reflection 不带，故可选。
struct V2ReflectionRecord: Codable, Equatable, Sendable {
  let id: String
  let attemptState: String
  let cause: String
  let masteryFeeling: Int
  let summary: String?
  let adoptedAi: Bool
  let source: String
  let createdAt: Date
  let status: V2ItemStatus?
}

/// GET /v2/items/:id/reflection 的一轮问答。
struct V2ReflectionTurn: Codable, Equatable, Sendable {
  let turn: Int
  let question: String
  let source: V2ReflectionSource
  let answer: String?
}

/// 最近一次 AI 归纳（详情里恒为非空字段；未归纳时整个 suggestion 为 null）。
struct V2ReflectionSuggestion: Codable, Equatable, Sendable {
  let summary: String
  let suggestedCause: String
  let suggestedAttemptState: String
}

/// GET /v2/items/:id/reflection 响应。
struct V2ReflectionDetail: Codable, Equatable, Sendable {
  let turns: [V2ReflectionTurn]
  let suggestion: V2ReflectionSuggestion?
  let reflection: V2ReflectionRecord?
}
