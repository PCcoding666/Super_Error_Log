import Foundation

// /v2 周视图、登记、设置（docs/mobile-v2-api.md §3.1–3.7）。
// 字段名与可空性以 src/v2 各 service 的类型为准（如 shortId/subject/questionExcerpt 可为 null）。

/// GET /v2/health → {"protocolVersion":2}
struct V2Health: Codable, Equatable, Sendable {
  let protocolVersion: Int
}

/// POST /v2/photos/:jobId/register 响应。
struct V2PhotoRegistration: Codable, Equatable, Sendable {
  let jobId: String
  let registeredAt: Date
}

/// 错题卡片（/v2/week 的 item、回报 masteredNow 等同形）。
struct V2ItemCard: Codable, Equatable, Sendable {
  let id: String
  let shortId: String?
  let subject: String?
  let knowledgeTags: [String]
  let questionExcerpt: String?
  let badge: V2ItemBadge
  let status: V2ItemStatus
  let cropUrl: String
  let jobId: String
}

/// /v2/week 的照片行。
struct V2WeekPhoto: Codable, Equatable, Sendable {
  let jobId: String
  let registeredAt: Date
  let recognition: V2PhotoRecognition
  let bridged: Bool
  let bridgeError: String?
  let itemCount: Int
}

/// GET /v2/week 响应：items 为本周登记桥接出的题，backlog 为往周待处理题。
struct V2WeekView: Codable, Equatable, Sendable {
  let week: String
  let photos: [V2WeekPhoto]
  let items: [V2ItemCard]
  let backlog: [V2ItemCard]
}

/// discard / restore 响应：{"id":…,"status":…}
struct V2ItemStatusChange: Codable, Equatable, Sendable {
  let id: String
  let status: V2ItemStatus
}

/// GET/PUT /v2/settings。
struct V2Settings: Codable, Equatable, Sendable {
  let practiceSlot: String
  let paperLocation: V2PaperLocation
}
