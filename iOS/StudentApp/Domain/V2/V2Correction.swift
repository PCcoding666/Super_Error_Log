import Foundation

// /v2 识别结果视图与修改、修正即测量报告（docs/mobile-v2-api.md §3.21–3.25）。

/// GET /v2/items/:id/evidence 响应。revision 是修改接口的乐观并发依据。
struct V2Evidence: Codable, Equatable, Sendable {
  struct Observation: Codable, Equatable, Sendable {
    let id: String
    let kind: String
    let text: String
  }
  let questionText: String
  let subject: String
  let knowledgeTags: [String]
  let observations: [Observation]
  let badge: V2ItemBadge
  let revision: Int
}

/// 一条修改（§3.22/3.24 同形）：field 为 observation 时带 observationId；
/// find/replace 仅模型建议给出，键盘直改不带。
struct V2CorrectionChange: Codable, Equatable, Sendable {
  let field: V2CorrectionField
  let observationId: String?
  let before: String
  let after: String
  let find: String?
  let replace: String?
}

/// POST /v2/items/:id/correct 请求正文。clientRequestId 为幂等键（UUID）。
struct V2CorrectionRequest: Encodable, Equatable, Sendable {
  let instruction: String
  let method: V2CorrectionMethod
  let revision: Int
  let clientRequestId: String
}

/// POST /v2/items/:id/correct 响应。
struct V2CorrectionProposal: Codable, Equatable, Sendable {
  let proposalId: String
  let revision: Int
  let changes: [V2CorrectionChange]
  let clarify: String?
}

/// POST /v2/items/:id/correct/accept 请求正文。
struct V2CorrectionAcceptRequest: Encodable, Equatable, Sendable {
  let proposalId: String
  let revision: Int
}

/// POST /v2/items/:id/correct/direct 请求正文（before 必须与当前值完全一致）。
struct V2CorrectionDirectRequest: Encodable, Equatable, Sendable {
  let revision: Int
  let changes: [V2CorrectionChange]
}

/// 接受建议与键盘直改的成功响应（§3.23/3.24 同形）。
struct V2CorrectionAcceptance: Codable, Equatable, Sendable {
  let revision: Int
  let card: V2ItemCard
}

/// 修正即测量报告（§3.25）：只含计数，不含题目文字。
struct V2CorrectionsReport: Codable, Equatable, Sendable {
  struct FieldStat: Codable, Equatable, Sendable {
    let field: String
    let corrected: Int
    let total: Int
    let rate: Double
  }
  struct NotAMistakeStat: Codable, Equatable, Sendable {
    let count: Int
    let rate: Double
  }
  struct Week: Codable, Equatable, Sendable {
    let week: String
    let itemCount: Int
    let fields: [FieldStat]
    let notAMistake: NotAMistakeStat
  }
  let weeks: [Week]
}
