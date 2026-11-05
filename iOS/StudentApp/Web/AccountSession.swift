import Foundation
import Observation

/// 登录凭据的存取：生产在钥匙串，测试用内存。
protocol CredentialStoring: Sendable {
  func load() -> PairingConfiguration?
  func save(_ configuration: PairingConfiguration) throws
  func remove()
}

struct KeychainCredentials: CredentialStoring {
  let scope: String

  /// 与旧版 StudyStore 同一份数据集合名：正常使用是 StudentExperience；UI 测试用 `-test-session <uuid>` 各自隔离。
  static func defaultScope() -> String {
    #if DEBUG
    let arguments = ProcessInfo.processInfo.arguments
    if let index = arguments.firstIndex(of: "-test-session"), arguments.indices.contains(index + 1),
      let id = UUID(uuidString: arguments[index + 1]) { return "UITest-\(id.uuidString)" }
    #endif
    return "StudentExperience"
  }

  func load() -> PairingConfiguration? { (try? PairingStore.load(scope: scope)) ?? nil }
  func save(_ configuration: PairingConfiguration) throws { try PairingStore.save(configuration, scope: scope) }
  func remove() { PairingStore.remove(scope: scope) }
}

/// 邀请码登录状态与网络面。网页版用 cookie 会话；原生用 `/s/native/login` 换来的 Bearer 令牌，
/// 同一个账号、同一份服务器记录。令牌失效（401）时回到登录页并提示重新输入邀请码。
@MainActor @Observable
final class AccountSession {
  private(set) var configuration: PairingConfiguration?
  private(set) var api: (any WebAPI)?
  /// 登录页顶部的一句提示（登录失效、已退出等）。
  var notice: String?
  /// 登录失败的原因（服务器给的话，不含令牌）。
  private(set) var loginError: String?
  private(set) var isLoggingIn = false
  let uploads = UploadQueue()

  private let credentials: any CredentialStoring
  private let makeAPI: @Sendable (PairingConfiguration) -> any WebAPI
  private let makeAuthClient: @Sendable (PairingConfiguration) -> RecognitionClient

  var isLoggedIn: Bool { api != nil }

  init(credentials: any CredentialStoring = KeychainCredentials(scope: KeychainCredentials.defaultScope()),
    makeAPI: @escaping @Sendable (PairingConfiguration) -> any WebAPI = { WebClient(configuration: $0) },
    makeAuthClient: @escaping @Sendable (PairingConfiguration) -> RecognitionClient = { RecognitionClient(configuration: $0) }) {
    self.credentials = credentials
    self.makeAPI = makeAPI
    self.makeAuthClient = makeAuthClient
    // 只认邀请码登录存下的凭据；旧版扫码配对留下的凭据不拿来用（那套接口已经不在界面里）。
    if let saved = credentials.load(), saved.isInvitation { adopt(saved) }
  }

  /// 邀请码登录。成功后保存凭据、切到已登录；失败返回 false，原因在 `loginError`。
  @discardableResult
  func login(code: String, host: String = CloudPairing.domainHost) async -> Bool {
    guard !isLoggingIn else { return false }
    isLoggingIn = true
    loginError = nil
    defer { isLoggingIn = false }
    guard let entry = CloudPairing.nativeAPIURL(forHost: host) else { loginError = "只接受官方云服务的入口。"; return false }
    guard let bootstrap = try? PairingConfiguration.invitation(
      baseURL: entry, serviceId: UUID().uuidString, token: String(repeating: "x", count: 32), expiresAt: nil)
    else { loginError = "登录请求无法构造，请重试。"; return false }
    let client = makeAuthClient(bootstrap)
    defer { client.close() }
    do {
      let result = try await client.loginInvitation(code: InvitationCode.normalize(code) ?? code, deviceInfo: "iPhone")
      let configuration = try PairingConfiguration.invitation(
        baseURL: entry, serviceId: result.serviceId, token: result.token, expiresAt: result.expiresAt)
      try credentials.save(configuration)
      notice = nil
      adopt(configuration)
      return true
    } catch {
      loginError = error.localizedDescription
      return false
    }
  }

  /// 退出登录：尽力让服务器撤销这枚令牌（失败不阻塞），然后清掉本机凭据。错题记录在服务器上，重新登录就能看到。
  func logout() async {
    if let configuration {
      let client = makeAuthClient(configuration)
      try? await client.logoutInvitation()
      client.close()
    }
    clear()
    notice = nil
  }

  /// 服务器说令牌无效（401）：清掉凭据，回登录页。
  func expire() {
    guard isLoggedIn else { return }
    clear()
    notice = "登录已失效，请重新输入邀请码。"
  }

  private func adopt(_ configuration: PairingConfiguration) {
    self.configuration = configuration
    let base = makeAPI(configuration)
    let guarded = GuardedAPI(base: base, onUnauthorized: { [weak self] in Task { @MainActor in self?.expire() } })
    api = guarded
    uploads.bind(api: guarded)
  }

  private func clear() {
    credentials.remove()
    configuration = nil
    api = nil
    uploads.bind(api: nil)
  }
}
