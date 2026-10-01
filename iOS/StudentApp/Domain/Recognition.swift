import Foundation

enum RecognitionCodec {
  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      // Local snapshots use Foundation's numeric date encoding; HTTP uses ISO 8601.
      if let numeric = try? container.decode(Double.self) { return Date(timeIntervalSinceReferenceDate: numeric) }
      let value = try container.decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: value) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      guard let date = formatter.date(from: value) else { throw StudyError.unsupportedState }
      return date
    }
    return decoder
  }
}

enum PairingScope {
  static func account(collectionName: String) -> String? {
    if collectionName == "StudentExperience" { return "loopback-pairing" }
    guard collectionName.hasPrefix("UITest-"), let id = UUID(uuidString: String(collectionName.dropFirst(7))) else { return nil }
    return "loopback-pairing-qa-" + id.uuidString
  }
}

struct RecognitionFailure: Codable, Equatable, Sendable {
  let code: String
  let message: String
  let stage: String
  let retryable: Bool
  var recoverable: Bool? = nil
  var canRecover: Bool { recoverable ?? retryable }
}

struct RecognitionBox: Codable, Equatable, Sendable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  var valid: Bool {
    [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
      && x + width <= 1 && y + height <= 1
  }
}

struct RecognitionRegion: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let kind: String
  let box: RecognitionBox
  let confidence: Double
  let cleanForPrint: Bool
}

struct SourceObservation: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let kind: String
  let text: String
  let regionId: String?
  let confidence: Double
  var label: String {
    switch kind {
    case "student_work": "原作过程"
    case "correction": "订正痕迹"
    case "teacher_note": "教师批注"
    case "reference_answer": "参考答案"
    default: "来源待核对"
    }
  }
}

struct RecognitionEvidence: Codable, Equatable, Sendable {
  let version: Int
  let questionNumber: String
  let questionText: String
  let subject: String
  let chapter: String
  let knowledgeTags: [String]
  let questionType: String
  let questionRegion: RecognitionBox
  let requiresDiagram: Bool
  let regions: [RecognitionRegion]
  let observations: [SourceObservation]
  let uncertainties: [String]
}

struct RecognitionVerification: Codable, Equatable, Sendable {
  let textComplete: Bool?
  let questionCropComplete: Bool?
  let questionCropPure: Bool?
  let transcriptionMatches: Bool?
  let diagramSafe: Bool?
  let issues: [String]
  var passed: Bool {
    textComplete == true && questionCropComplete == true && questionCropPure == true
      && transcriptionMatches == true && diagramSafe == true && issues.isEmpty
  }
}

struct RecognitionQuestion: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let number: String
  let revision: Int
  let status: String
  let selectionEvidence: String
  var candidateBox: RecognitionBox? = nil
  let evidence: RecognitionEvidence?
  let verification: RecognitionVerification?
  let questionMediaId: String?
  let diagramMediaIds: [String]
  var error: RecognitionFailure?
  let confirmedAt: Date?
  /// 人工放行标记（可选，旧记录无此字段则解码为 nil 视同 false）：needs_check 时学生对照原图后主动确认。
  var manualRelease: Bool? = nil

  var coreValue: RecognitionQuestion {
    var copy = self; copy.candidateBox = nil; copy.error?.recoverable = nil; return copy
  }
  func sameContent(as old: RecognitionQuestion) -> Bool {
    coreValue == old.coreValue && (old.candidateBox == nil || candidateBox == old.candidateBox)
  }

  var active: Bool { status == "queued" || status == "processing" }
  var marked: Bool { selectionEvidence == "marked_wrong" || selectionEvidence == "corrected" }
  var canAccept: Bool {
    // 人工放行（Task 2）：学生对照原图后主动拍板替代 AI 核对。仍需证据与题目裁图真实存在
    // （没有可核对对象不能进复盘），图示仍要求媒体齐备——缺图的题放了也看不了。
    if manualRelease == true, status == "confirmed",
      let evidence, evidence.version == 1, !evidence.questionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let questionMediaId, UUID(uuidString: questionMediaId) != nil {
      let diagrams = evidence.regions.filter { $0.kind == "diagram" }
      return (!evidence.requiresDiagram || !diagrams.isEmpty)
        && diagrams.count == diagramMediaIds.count
        && diagramMediaIds.allSatisfy { UUID(uuidString: $0) != nil }
    }
    guard ["ready", "confirmed"].contains(status), verification?.passed == true,
      let evidence, evidence.version == 1, !evidence.questionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      evidence.uncertainties.isEmpty, let questionMediaId, UUID(uuidString: questionMediaId) != nil
    else { return false }
    let diagrams = evidence.regions.filter { $0.kind == "diagram" }
    return (!evidence.requiresDiagram || !diagrams.isEmpty)
      && diagrams.count == diagramMediaIds.count
      && diagramMediaIds.allSatisfy { UUID(uuidString: $0) != nil }
  }
  var statusTitle: String {
    switch status {
    case "queued": "等待识别"
    case "processing": "正在识别"
    case "ready": "待你确认"
    case "needs_check": "有内容需核对"
    case "confirmed": "已确认"
    case "skipped": "暂不处理"
    case "failed": "识别未完成"
    default: "状态需核对"
    }
  }
  var currentIssue: String? {
    evidence?.uncertainties.first ?? verification?.issues.first ?? error?.message
      ?? (status == "needs_check" ? "这道题还没有通过完整性核对，请对照原图，暂时保留不确定。" : nil)
  }
}

struct RecognitionJob: Codable, Equatable, Identifiable, Sendable {
  let version: Int
  let id: String
  let revision: Int
  let photoName: String
  let sourceHash: String
  let sourceMediaId: String
  let status: String
  let phase: String
  let inventoryWarnings: [String]
  var questions: [RecognitionQuestion]
  var error: RecognitionFailure?
  let createdAt: Date
  let updatedAt: Date
  var coreValue: RecognitionJob {
    var copy = self; copy.questions = questions.map(\.coreValue); copy.error?.recoverable = nil; return copy
  }
  var active: Bool { ["queued", "processing"].contains(status) || questions.contains(where: \.active) }
  var statusTitle: String {
    switch status {
    case "queued": "等待识别"
    case "processing": phase == "inventory" ? "正在查找题目" : "正在逐题识别"
    case "completed": "已识别，待查看"
    case "partial": "部分识别完成"
    case "interrupted": "识别已中断"
    case "failed": "识别未完成"
    default: "状态需核对"
    }
  }
}

struct LocalRecognitionTask: Codable, Equatable, Identifiable, Sendable {
  let id: UUID
  let photoName: String
  let uploadName: String
  var consentedAt: Date?
  var job: RecognitionJob?
  var lastError: String?
  /// Task 4 review R2：归属服务（云端提交时随任务持久化；nil = 回环来源或旧文档）。
  /// 重启后凭此字段判断任务是否可向当前配对的服务自动刷新。
  var ownedServiceId: String?
  /// M1：最近一次刷新失败的分类（nil = 无失败或旧文档）。lastError 文案之外的结构化区分：
  /// 离线/服务暂不可用/配对失效/未知，驱动卡片显示「进度暂未更新」而非误报任务失败。
  var lastIssueKind: RefreshIssue?
  /// T6b：上传后是否已成功登记进 /v2 学习闭环（旧存档解码为 nil = 未登记）。
  /// 登记失败不影响上传结果；nil/false 的任务在 refreshJobs 时补登记，404 记 false 后不再重试。
  var v2Registered: Bool?

  init(id: UUID, photoName: String, uploadName: String, consentedAt: Date? = nil,
    job: RecognitionJob? = nil, lastError: String? = nil, ownedServiceId: String? = nil,
    lastIssueKind: RefreshIssue? = nil, v2Registered: Bool? = nil) {
    self.id = id; self.photoName = photoName; self.uploadName = uploadName
    self.consentedAt = consentedAt; self.job = job; self.lastError = lastError
    self.ownedServiceId = ownedServiceId; self.lastIssueKind = lastIssueKind
    self.v2Registered = v2Registered
  }

  private enum CodingKeys: String, CodingKey {
    case id, photoName, uploadName, consentedAt, job, lastError, ownedServiceId, lastIssueKind, v2Registered
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(UUID.self, forKey: .id)
    photoName = try values.decode(String.self, forKey: .photoName)
    uploadName = try values.decode(String.self, forKey: .uploadName)
    consentedAt = try values.decodeIfPresent(Date.self, forKey: .consentedAt)
    job = try values.decodeIfPresent(RecognitionJob.self, forKey: .job)
    lastError = try values.decodeIfPresent(String.self, forKey: .lastError)
    // 旧文档无归属字段：解码为 nil（回环语义），不拒绝加载。
    ownedServiceId = try values.decodeIfPresent(String.self, forKey: .ownedServiceId)
    // 旧文档无分类字段：解码为 nil，不拒绝加载。
    lastIssueKind = try values.decodeIfPresent(RefreshIssue.self, forKey: .lastIssueKind)
    // 旧文档无登记字段：解码为 nil（未登记），不拒绝加载。
    v2Registered = try values.decodeIfPresent(Bool.self, forKey: .v2Registered)
  }
}

/// 双模式配对（Task 4）：
/// - loopback：现有回环校验不变（http + 127.0.0.1/localhost/[::1] + 16 位口令）。
/// - cloud：固定云域名 HTTPS + 设备令牌 + deviceId（UUID）+ 可选到期。
/// 注意：Codable 按模式存储；`baseURL`/`token` 提供模式无关访问。
struct PairingConfiguration: Codable, Equatable, Sendable {
  #if DEBUG
  /// Task 5（仅 DEBUG）：UI 测试把云模式指向本机合成服务器（`-cloud-loopback` 启动参数）。
  /// Release 构建此覆盖恒为 nil；生产始终使用固定云域名。覆盖必须是合法回环 http URL，
  /// 其他任何值（包括远程主机）一律忽略——不能借测试通道绕过固定域名约束。
  static let testCloudOverride: URL? = {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-cloud-loopback"),
      arguments.indices.contains(index + 1),
      let parts = URLComponents(string: arguments[index + 1]),
      parts.scheme == "http", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(parts.host ?? ""),
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      ["", "/"].contains(parts.path), let url = parts.url
    else { return nil }
    return url
  }()
  #else
  static let testCloudOverride: URL? = nil
  #endif

  private let mode: Mode
  private let loopbackURL: URL?
  private let loopbackToken: String?
  private let cloudServiceId: String?
  private let cloudToken: String?
  private let cloudDeviceId: String?
  private let cloudExpiresAt: Date?

  enum Mode: String, Codable, Sendable { case loopback, cloud }

  init(baseURL: String, token: String) throws {
    guard let parts = URLComponents(string: baseURL), parts.scheme == "http",
      ["127.0.0.1", "localhost", "[::1]", "::1"].contains(parts.host ?? ""),
      let port = parts.port, (1...65535).contains(port), parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path),
      let url = parts.url, token.count >= 16, !token.contains("\n"), !token.contains("\r")
    else { throw RecognitionClientError.invalidPairing }
    mode = .loopback
    loopbackURL = url
    loopbackToken = token
    cloudServiceId = nil; cloudToken = nil; cloudDeviceId = nil; cloudExpiresAt = nil
  }

  static func cloud(serviceId: String, token: String, deviceId: String, expiresAt: Date?) throws -> PairingConfiguration {
    guard UUID(uuidString: serviceId) != nil,
      token.count >= 16, !token.contains("\n"), !token.contains("\r"),
      UUID(uuidString: deviceId) != nil
    else { throw RecognitionClientError.invalidPairing }
    return PairingConfiguration(mode: .cloud, loopbackURL: nil, loopbackToken: nil,
      cloudServiceId: serviceId, cloudToken: token, cloudDeviceId: deviceId, cloudExpiresAt: expiresAt)
  }

  private init(mode: Mode, loopbackURL: URL?, loopbackToken: String?,
    cloudServiceId: String?, cloudToken: String?, cloudDeviceId: String?, cloudExpiresAt: Date?) {
    self.mode = mode
    self.loopbackURL = loopbackURL
    self.loopbackToken = loopbackToken
    self.cloudServiceId = cloudServiceId
    self.cloudToken = cloudToken
    self.cloudDeviceId = cloudDeviceId
    self.cloudExpiresAt = cloudExpiresAt
  }

  var isCloud: Bool { mode == .cloud }

  /// 模式无关的请求基地址（回环：本机 URL；云端：固定云域名；DEBUG UI 测试：回环覆盖）。
  var baseURL: URL {
    switch mode {
    case .loopback: loopbackURL!
    case .cloud: Self.testCloudOverride ?? URL(string: CloudPairing.allowedURL)!
    }
  }

  /// 模式无关的鉴权令牌（回环：共享口令；云端：设备令牌）。
  var token: String {
    switch mode {
    case .loopback: loopbackToken!
    case .cloud: cloudToken!
    }
  }

  /// 云端归属三件套：serviceId / deviceId / 到期。回环模式全部为 nil。
  var serviceId: String? { isCloud ? cloudServiceId : nil }
  var deviceId: String? { isCloud ? cloudDeviceId : nil }
  var expiresAt: Date? { isCloud ? cloudExpiresAt : nil }

  /// 编码兼容：回环模式按旧的 { baseURL, token } 形状存储（老数据可读）；
  /// 云端模式按显式模式字段存储。
  private enum CodingKeys: String, CodingKey {
    case baseURL, token, mode, serviceId, deviceId, expiresAt
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    if let mode = try values.decodeIfPresent(Mode.self, forKey: .mode) {
      guard mode == .cloud else { throw RecognitionClientError.invalidPairing }
      let serviceId = try values.decode(String.self, forKey: .serviceId)
      let token = try values.decode(String.self, forKey: .token)
      let deviceId = try values.decode(String.self, forKey: .deviceId)
      let expiresAt = try values.decodeIfPresent(Date.self, forKey: .expiresAt)
      self = try PairingConfiguration.cloud(serviceId: serviceId, token: token, deviceId: deviceId, expiresAt: expiresAt)
      return
    }
    // 旧形状（回环）：重新走完整校验，不信任磁盘上的任何字段。
    let baseURL = try values.decode(String.self, forKey: .baseURL)
    let token = try values.decode(String.self, forKey: .token)
    self = try PairingConfiguration(baseURL: baseURL, token: token)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch mode {
    case .loopback:
      try container.encode(loopbackURL!.absoluteString, forKey: .baseURL)
      try container.encode(loopbackToken!, forKey: .token)
    case .cloud:
      try container.encode(Mode.cloud, forKey: .mode)
      try container.encode(cloudServiceId!, forKey: .serviceId)
      try container.encode(cloudToken!, forKey: .token)
      try container.encode(cloudDeviceId!, forKey: .deviceId)
      if let cloudExpiresAt { try container.encode(cloudExpiresAt, forKey: .expiresAt) }
    }
  }
}

enum RecognitionClientError: Error, LocalizedError {
  case invalidPairing, invalidResponse, service(String), missingMedia
  /// Task 4 review R1：携带 HTTP 状态码的服务错误——状态机按状态分类，不再依赖文案子串。
  case server(status: Int, message: String)
  /// 协议/归属不兼容（health version/protocolVersion 不符、serviceId 不一致）。
  case incompatiblePairing
  /// M1：保留底层 URLError 的传输失败——刷新错误分类（离线/超时/服务不可用）依赖它，不再全部塌缩成文案。
  case networkFailure(URLError)
  var errorDescription: String? {
    switch self {
    case .invalidPairing: "请输入本机回环地址（如 http://127.0.0.1:3101）和至少 16 位配对口令。"
    case .invalidResponse: "本机服务返回的内容无法安全使用，请检查连接后重试。"
    case .service(let message): message
    case .missingMedia: "题目需要的安全图示尚未完整保存在本机，暂时不能生成练习包。"
    case .server(_, let message): message
    case .incompatiblePairing: "识别服务版本或归属与配对不一致，请重新扫码配对。"
    case .networkFailure(let error): "暂时连不上识别服务。已保存的照片和结果仍可查看，请检查连接后重试。（\(error.code.rawValue)）"
    }
  }
}
