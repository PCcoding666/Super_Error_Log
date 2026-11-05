import Foundation

// 网页版（client/）和原生 App 共用的接口形状。字段名、含义以 src/web/apiTypes.ts 为准，改那边先改这里。
// 服务端新增字段 App 忽略即可（Codable 默认忽略未知键）；缺字段用默认值，免得服务端小改动让整页打不开。

/// 错题本的四档状态（见服务端 notebook.ts）；未知值按「待做」处理。
enum NotebookStatus: String, Sendable {
  case todo, practicing, mastered, stable
}

struct NotebookItem: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let shortId: String?
  let subject: String
  let grade: String?
  let chapter: String
  let knowledgeTags: [String]
  /// 题干摘录；没有可读文字时为空串。
  let excerpt: String
  let status: String
  let statusLabel: String
  /// 缩略图（题干裁图），服务端路径（/s/img/…）。
  let thumb: String
  /// 录入日 YYYY-MM-DD；旧数据可能为 nil。
  let intakeDay: String?

  var statusValue: NotebookStatus { NotebookStatus(rawValue: status) ?? .todo }
}

struct NotebookGroup: Codable, Equatable, Identifiable, Sendable {
  /// today / week / earlier
  let key: String
  let title: String
  let items: [NotebookItem]
  var id: String { key }
}

struct NotebookResponse: Codable, Equatable, Sendable {
  let subject: String
  let subjects: [String]
  let grade: String
  let stages: [String]
  let chapter: String
  let chapters: [String]
  let status: String
  let tag: String
  let tags: [String]
  let q: String
  /// 这个学科和学段下的总数（不受章节 / 状态 / 搜索影响）。
  let total: Int
  /// 当前筛选结果数。
  let shown: Int
  let todo: Int
  let groups: [NotebookGroup]
  /// 还在找题的照片数。
  let finding: Int
  /// 照片里还有没收进错题本的题（材料流程）。
  let pendingIntake: Int

  var items: [NotebookItem] { groups.flatMap(\.items) }
}

struct ItemImage: Codable, Equatable, Sendable, Identifiable {
  let url: String
  let fullUrl: String
  let title: String
  var id: String { url }
}

struct ItemNote: Codable, Equatable, Sendable, Identifiable {
  let kind: String
  let title: String
  let text: String
  var id: String { kind }
}

struct ChapterOptions: Codable, Equatable, Sendable {
  let grade: String
  let subject: String
  let chapters: [String]
}

struct ItemCategory: Codable, Equatable, Sendable {
  let grade: String
  let subject: String
  let chapter: String
  let stages: [String]
  let subjects: [String]
  let chapterOptions: [ChapterOptions]

  /// 某个「学段 × 学科」下可选的章节。
  func chapters(grade: String, subject: String) -> [String] {
    chapterOptions.first { $0.grade == grade && $0.subject == subject }?.chapters ?? []
  }
}

struct ItemDetailResponse: Codable, Equatable, Sendable {
  let item: NotebookItem
  let questionText: String
  /// ok / low：low 表示字可能认错了。
  let badge: String
  let revision: Int?
  let images: [ItemImage]
  let notes: [ItemNote]
  let canDiscard: Bool
  let category: ItemCategory
  /// 材料流程的题：网页版有「查看材料来源」旧页面；原生不放这个入口。
  let materialUrl: String?
}

struct DiscardFailure: Codable, Equatable, Sendable {
  let id: String
  let message: String
}

struct DiscardResponse: Codable, Equatable, Sendable {
  let removed: [String]
  let failed: [DiscardFailure]
}

struct SettingsResponse: Codable, Equatable, Sendable {
  let grade: String
  let stages: [String]
  /// 邀请码网关下才有退出登录。
  let invitation: Bool
  let accountRole: String?
  let accountRoleLabel: String?
  /// ISO 时间或 nil：邀请码快到期提醒；"none" 表示已没有可用的码。
  let inviteExpires: String?
  let version: String

  /// 7 天内到期（或没有可用邀请码）才提醒。
  func inviteExpiresSoon(now: Date = Date()) -> Bool {
    guard let inviteExpires, inviteExpires != "none" else { return false }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: inviteExpires) ?? {
      formatter.formatOptions = [.withInternetDateTime]
      return formatter.date(from: inviteExpires)
    }()
    guard let date else { return false }
    return date.timeIntervalSince(now) < 7 * 86400
  }
}

/// 拍照上传走哪套端点：旧识别流程（/capture）还是材料流程（/materials/*）。
struct UploadModeResponse: Codable, Equatable, Sendable {
  let mode: String
  let draftNamespace: String?

  var uploadMode: UploadMode {
    if mode == "materials", let draftNamespace, !draftNamespace.isEmpty { return .materials(namespace: draftNamespace) }
    return .legacy
  }
}

enum UploadMode: Equatable, Sendable {
  case legacy
  case materials(namespace: String)
}

enum IntakePhotoState: String, Sendable {
  case finding, done, needsPick, failed, unsupported
}

struct IntakeQuestion: Codable, Equatable, Identifiable, Sendable {
  /// 错题本里的题目 id（itm_…）。
  let id: String
  let excerpt: String
  let chapter: String
  let thumb: String
}

struct IntakeCandidate: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let label: String
  let excerpt: String
  /// 裁图；材料流程没有裁图时为 nil。
  let crop: String?
}

struct IntakeFailure: Codable, Equatable, Sendable {
  let title: String
  let detail: String
  let retryable: Bool
}

struct IntakePhoto: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let number: Int
  let takenAt: String
  let thumb: String
  let full: String
  let state: String
  let statusText: String
  let questions: [IntakeQuestion]
  let candidates: [IntakeCandidate]
  let failure: IntakeFailure?

  var stateValue: IntakePhotoState { IntakePhotoState(rawValue: state) ?? .done }
  var takenDate: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: takenAt) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: takenAt)
  }
}

struct IntakeResponse: Codable, Equatable, Sendable {
  let mode: String
  let draftNamespace: String?
  let photos: [IntakePhoto]
  /// 还有照片在找题：客户端据此轮询。
  let busy: Bool

  var uploadMode: UploadMode {
    if mode == "materials", let draftNamespace, !draftNamespace.isEmpty { return .materials(namespace: draftNamespace) }
    return .legacy
  }
}

/// 服务端统一的错误信封 `{ error: { code, message } }`，加上传输层失败（code = network）。
struct WebAPIError: Error, LocalizedError, Equatable, Sendable {
  let status: Int
  let code: String
  let message: String

  var errorDescription: String? { message }
  /// 新账号还没选学段：所有接口回 409 stage_required。
  var isStageRequired: Bool { code == "stage_required" }
  /// 令牌失效或被撤销：要重新输入邀请码。
  var isUnauthorized: Bool { status == 401 }

  static let unreachable = WebAPIError(status: 0, code: "network", message: "暂时连不上，稍后再试。")
  static let badResponse = WebAPIError(status: 0, code: "bad_response", message: "服务器返回的内容看不懂，稍后再试。")
}
