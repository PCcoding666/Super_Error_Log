import Foundation

/// Task 4: 云端扫码配对解析、健康快照与连接状态机。
/// 只接受白名单里两个固定入口的 HTTPS 二维码：IP 直连 `https://8.163.96.197`（2026-10-03 起服务端默认，
/// 证书由 CloudTLSPinning 固定）与域名 `https://study.pccoding666.com`（保留，系统证书校验）。
/// 拒绝任意其他服务器、携带凭据/端口/路径/查询的 URL；协议代次必须为 1。
enum CloudPairing {
  static let ipHost = "8.163.96.197"
  static let domainHost = "study.pccoding666.com"
  static let allowedHosts = [ipHost, domainHost]
  static let domainURL = "https://\(domainHost)"

  /// 白名单主机对应的规范入口地址（无尾斜杠）；其他主机返回 nil。
  static func url(forHost host: String) -> String? {
    allowedHosts.contains(host) ? "https://\(host)" : nil
  }

  struct ParsedQR: Equatable, Sendable {
    let v: Int
    let serviceId: String
    let httpsUrl: String
    let sessionId: String
    let secret: String
  }

  enum QRParseError: Error, LocalizedError, Equatable {
    case invalidJSON, invalidVersion, invalidURL, invalidServiceID, invalidSessionID, invalidSecret
    var errorDescription: String? {
      switch self {
      case .invalidJSON: "二维码内容不是有效的配对 JSON。"
      case .invalidVersion: "配对二维码版本不受支持，请更新应用后重试。"
      case .invalidURL: "配对二维码指向的服务不受信任；只接受官方云服务的 HTTPS 地址。"
      case .invalidServiceID: "二维码中的服务标识不合法。"
      case .invalidSessionID: "二维码中的配对会话不合法。"
      case .invalidSecret: "二维码中的配对密钥不合法。"
      }
    }
  }

  /// 解析配对二维码 JSON。未知字段容忍（前向兼容）；已知字段必须全部合法。
  static func parse(_ text: String) throws -> ParsedQR {
    struct Document: Decodable {
      let v: Int
      let serviceId: String
      let httpsUrl: String
      let sessionId: String
      let secret: String
    }
    let document: Document
    do { document = try JSONDecoder().decode(Document.self, from: Data(text.utf8)) }
    catch { throw QRParseError.invalidJSON }
    guard document.v == 1 else { throw QRParseError.invalidVersion }
    // 固定入口白名单：https、主机在白名单内、无端口、无路径/查询/fragment、无用户信息。
    guard let parts = URLComponents(string: document.httpsUrl),
      parts.scheme == "https", let host = parts.host, let httpsUrl = url(forHost: host), parts.port == nil,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      ["", "/"].contains(parts.path)
    else { throw QRParseError.invalidURL }
    guard UUID(uuidString: document.serviceId) != nil else { throw QRParseError.invalidServiceID }
    guard UUID(uuidString: document.sessionId) != nil else { throw QRParseError.invalidSessionID }
    // 密钥：至少 32 字符 base64url 字母表，无空白/换行。
    guard document.secret.count >= 32,
      !document.secret.contains(where: { $0.isWhitespace || $0.isNewline }),
      document.secret.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_".contains($0)) })
    else { throw QRParseError.invalidSecret }
    return ParsedQR(v: document.v, serviceId: document.serviceId,
      httpsUrl: httpsUrl, sessionId: document.sessionId, secret: document.secret)
  }
}

/// 云端 `/v1/health`（已鉴权）响应。serviceId 缺失或版本不符直接解码失败——
/// 这是「归属校验」的一部分：健康响应必须声明它属于哪一个服务。
struct HealthSnapshot: Codable, Equatable, Sendable {
  let version: Int
  let serviceId: String
  let storageAvailable: Bool
  let visionConfigured: Bool
  let acceptingJobs: Bool
  let protocolVersion: Int

  enum CodingKeys: String, CodingKey {
    case version, serviceId, storageAvailable, visionConfigured, acceptingJobs, protocolVersion
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    version = try values.decode(Int.self, forKey: .version)
    guard version == 1 else { throw StudyError.unsupportedState }
    protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
    guard protocolVersion == 1 else { throw StudyError.unsupportedState }
    serviceId = try values.decode(String.self, forKey: .serviceId)
    guard UUID(uuidString: serviceId) != nil else { throw StudyError.unsupportedState }
    storageAvailable = try values.decode(Bool.self, forKey: .storageAvailable)
    visionConfigured = try values.decode(Bool.self, forKey: .visionConfigured)
    acceptingJobs = try values.decode(Bool.self, forKey: .acceptingJobs)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(version, forKey: .version)
    try container.encode(serviceId, forKey: .serviceId)
    try container.encode(storageAvailable, forKey: .storageAvailable)
    try container.encode(visionConfigured, forKey: .visionConfigured)
    try container.encode(acceptingJobs, forKey: .acceptingJobs)
    try container.encode(protocolVersion, forKey: .protocolVersion)
  }
}

/// 连接状态机的显示语义（中文文案与操作在 Task 5 接 UI 时呈现；这里先固化语义）。
enum ConnectionState: Equatable, Sendable {
  case unpaired, pairedNeedsCheck, checking, ready, busy, failed, unauthorized, incompatible

  /// UI 稳定标识（accessibility identifier 用）。
  var key: String {
    switch self {
    case .unpaired: "unpaired"
    case .pairedNeedsCheck: "paired_needs_check"
    case .checking: "checking"
    case .ready: "ready"
    case .busy: "busy"
    case .failed: "failed"
    case .unauthorized: "unauthorized"
    case .incompatible: "incompatible"
    }
  }

  var canUpload: Bool {
    switch self {
    case .ready: true
    default: false
    }
  }

  var title: String {
    switch self {
    case .unpaired: "未连接识别服务"
    case .pairedNeedsCheck: "已配对，待检查"
    case .checking: "正在检查连接"
    case .ready: "可以上传"
    case .busy: "服务繁忙"
    case .failed: "连接失败"
    case .unauthorized: "授权已失效"
    case .incompatible: "版本不兼容"
    }
  }

  var actionTitle: String {
    switch self {
    case .unpaired: "扫码配对"
    case .pairedNeedsCheck: "检查连接"
    case .checking: "请稍候"
    case .ready: "开始上传"
    case .busy: "稍后再试"
    case .failed: "重试连接"
    case .unauthorized: "重新配对"
    case .incompatible: "查看帮助"
    }
  }
}

/// 重新配对同一服务时的代次护栏：迟到旧响应按代次丢弃。
/// beginCheck() 返回「完成器」；只有当前代次的完成器才允许改写状态。
@MainActor
final class ConnectionTracker: @unchecked Sendable {
  private(set) var state: ConnectionState = .unpaired
  private var generation = 0

  func paired() -> Int {
    state = .pairedNeedsCheck
    generation += 1
    return generation
  }

  /// 重新配对/切换服务：代次 +1，旧响应全部作废。
  func repair() -> Int {
    generation += 1
    state = .unpaired
    return generation
  }

  typealias CheckCompletion = @MainActor (Result<Bool, Error>) -> Void

  func beginCheck() -> CheckCompletion {
    state = .checking
    let current = generation
    return { [weak self] outcome in
      guard let self, self.generation == current else { return } // 迟到旧代次：丢弃
      switch outcome {
      case .success(let accepting):
        if accepting { self.state = .ready }
        else { self.state = .busy }
      case .failure(let error):
        self.state = Self.classify(error)
      }
    }
  }

  var currentState: ConnectionState { state }

  /// Task 4 review R1：按结构化错误分类——HTTP 状态码与协议不兼容是唯一可信依据，
  /// 服务器中文文案（可变更）不参与分类。
  static func classify(_ error: Error) -> ConnectionState {
    if let clientError = error as? RecognitionClientError {
      switch clientError {
      case .server(let status, _) where status == 401: return .unauthorized
      case .incompatiblePairing: return .incompatible
      default: break
      }
    }
    return .failed
  }
}
