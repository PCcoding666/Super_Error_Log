import Foundation

/// 修改接口的 409 且响应顶层带 revision 时抛出：用新 revision 刷新后让学生重试，不自动重放。
/// 其余错误沿用 RecognitionClientError（.server/.networkFailure/.invalidResponse），不改动其既有分支含义。
enum V2ClientError: Error, Equatable, Sendable {
  case revisionConflict(message: String, currentRevision: Int)
}

/// T6g：裁图范围（docs/mobile-v2-api.md §3.3）。缺省题干小图；full 为整题大图（含全部手写证据）。
enum V2CropScope: String, Sendable {
  case question
  case full
}

/// /v2 全部接口的类型化客户端（docs/mobile-v2-api.md 为唯一依据）。
/// 鉴权与安全沿用 RecognitionClient 约定：Bearer 令牌、拒绝一切重定向、不使用本地缓存、
/// 错误文案令牌脱敏。无 UIKit/SwiftUI，不写日志，不保存任何状态。
final class V2Client: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let configuration: PairingConfiguration
  /// IP 入口的证书固定（与 RecognitionClient 相同；测试可注入）。
  let pinning: CloudTLSPinning
  private var session: URLSession!

  init(configuration: PairingConfiguration, sessionConfiguration: URLSessionConfiguration = .ephemeral,
    pinning: CloudTLSPinning = .production) {
    self.configuration = configuration
    self.pinning = pinning
    super.init()
    sessionConfiguration.timeoutIntervalForRequest = 60
    sessionConfiguration.timeoutIntervalForResource = 300
    sessionConfiguration.urlCache = nil
    sessionConfiguration.httpCookieStorage = nil
    session = URLSession(configuration: sessionConfiguration, delegate: self, delegateQueue: nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    // 任何重定向（可能携带凭据）一律拒绝。
    completionHandler(nil)
  }

  /// IP 入口只信任 App 内固定的证书；域名与其他主机走系统默认校验（CloudTLSPinning）。
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let (disposition, credential) = pinning.disposition(for: challenge)
    completionHandler(disposition, credential)
  }

  func close() { session.invalidateAndCancel() }

  // MARK: - 健康检查（§1.6）

  func health() async throws -> V2Health {
    let health: V2Health = try await get("v2/health")
    guard health.protocolVersion == 2 else { throw RecognitionClientError.invalidResponse }
    return health
  }

  // MARK: - 登记与周视图（§3.1–3.5）

  func registerPhoto(jobId: String) async throws -> V2PhotoRegistration {
    try validateUUID(jobId)
    return try await post("v2/photos/\(jobId)/register")
  }

  func week() async throws -> V2WeekView {
    try await get("v2/week")
  }

  /// 整题裁图字节（带 Authorization；校验 JPEG）。
  /// scope 缺省为题干小图（不带查询参数，请求保持原样）；full 请求 `?scope=full` 整题大图。
  func crop(itemId: String, scope: V2CropScope = .question) async throws -> Data {
    try validatePrefixedID(itemId, prefix: "itm_")
    switch scope {
    case .question:
      return try await image("v2/items/\(itemId)/crop")
    case .full:
      // appendingPathComponent 会把 ? 编码掉，查询参数用 appending(queryItems:) 追加。
      let url = configuration.baseURL
        .appendingPathComponent("v2/items/\(itemId)/crop")
        .appending(queryItems: [URLQueryItem(name: "scope", value: "full")])
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
      request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
      return try await image(request)
    }
  }

  func discard(itemId: String) async throws -> V2ItemStatusChange {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await post("v2/items/\(itemId)/discard")
  }

  func restore(itemId: String) async throws -> V2ItemStatusChange {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await post("v2/items/\(itemId)/restore")
  }

  // MARK: - 设置（§3.6–3.7）

  func settings() async throws -> V2Settings {
    try await get("v2/settings")
  }

  func updateSettings(_ settings: V2Settings) async throws -> V2Settings {
    try await sendJSON("v2/settings", method: "PUT", body: settings)
  }

  // MARK: - 推荐与练习（§3.8–3.11）

  func recommend() async throws -> V2Recommendation {
    try await get("v2/practice/recommend")
  }

  func createPractice(itemIds: [String], practiceSlot: String? = nil) async throws -> V2PracticeDetail {
    for id in itemIds { try validatePrefixedID(id, prefix: "itm_") }
    return try await sendJSON("v2/practice", body: V2PracticeCreateRequest(itemIds: itemIds, practiceSlot: practiceSlot))
  }

  func practiceList() async throws -> [V2PracticeSummary] {
    try await get("v2/practice", as: V2PracticeList.self).packets
  }

  func practiceDetail(id: String) async throws -> V2PracticeDetail {
    try validatePrefixedID(id, prefix: "pkt_")
    return try await get("v2/practice/\(id)")
  }

  // MARK: - 打印（§3.12–3.14）

  /// 请求打印快照（异步）：202/200 均属成功，随后用 printStatus 轮询。
  func requestPrint(packetId: String) async throws -> V2PrintState {
    try validatePrefixedID(packetId, prefix: "pkt_")
    return try await post("v2/practice/\(packetId)/print")
  }

  func printStatus(packetId: String) async throws -> V2PrintState {
    try validatePrefixedID(packetId, prefix: "pkt_")
    return try await get("v2/practice/\(packetId)/print")
  }

  /// 快照图片字节（带 Authorization；校验 JPEG）。
  func printMedia(packetId: String, name: String) async throws -> Data {
    try validatePrefixedID(packetId, prefix: "pkt_")
    try validateMediaName(name)
    return try await image("v2/practice/\(packetId)/print/media/\(name)")
  }

  // MARK: - 回传与回报（§3.15–3.16）

  func returnResults(packetId: String, results: [V2ReturnEntry]) async throws -> V2ReturnResponse {
    try validatePrefixedID(packetId, prefix: "pkt_")
    for entry in results { try validatePrefixedID(entry.itemId, prefix: "itm_") }
    return try await sendJSON("v2/practice/\(packetId)/return", body: V2ReturnRequest(results: results))
  }

  func practiceSummary(packetId: String) async throws -> V2ReturnSummary {
    try validatePrefixedID(packetId, prefix: "pkt_")
    return try await get("v2/practice/\(packetId)/summary")
  }

  // MARK: - 追问与复盘（§3.17–3.20）

  func askReflection(itemId: String) async throws -> V2ReflectionQuestion {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await post("v2/items/\(itemId)/reflection/ask")
  }

  func answerReflection(itemId: String, answer: String) async throws -> V2ReflectionAnswerResult {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await sendJSON("v2/items/\(itemId)/reflection/answer", body: V2ReflectionAnswerRequest(answer: answer))
  }

  func submitReflection(itemId: String, submission: V2ReflectionSubmission) async throws -> V2ReflectionRecord {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await sendJSON("v2/items/\(itemId)/reflection", body: submission)
  }

  func reflectionDetail(itemId: String) async throws -> V2ReflectionDetail {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await get("v2/items/\(itemId)/reflection")
  }

  // MARK: - 识别结果视图与修改（§3.21–3.25）

  func evidence(itemId: String) async throws -> V2Evidence {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await get("v2/items/\(itemId)/evidence")
  }

  func proposeCorrection(itemId: String, instruction: String, method: V2CorrectionMethod, revision: Int, clientRequestId: String) async throws -> V2CorrectionProposal {
    try validatePrefixedID(itemId, prefix: "itm_")
    try validateUUID(clientRequestId)
    return try await sendJSON("v2/items/\(itemId)/correct",
      body: V2CorrectionRequest(instruction: instruction, method: method, revision: revision, clientRequestId: clientRequestId))
  }

  func acceptCorrection(itemId: String, proposalId: String, revision: Int) async throws -> V2CorrectionAcceptance {
    try validatePrefixedID(itemId, prefix: "itm_")
    try validatePrefixedID(proposalId, prefix: "crp_")
    return try await sendJSON("v2/items/\(itemId)/correct/accept",
      body: V2CorrectionAcceptRequest(proposalId: proposalId, revision: revision))
  }

  func correctDirectly(itemId: String, revision: Int, changes: [V2CorrectionChange]) async throws -> V2CorrectionAcceptance {
    try validatePrefixedID(itemId, prefix: "itm_")
    return try await sendJSON("v2/items/\(itemId)/correct/direct",
      body: V2CorrectionDirectRequest(revision: revision, changes: changes))
  }

  func correctionsReport() async throws -> V2CorrectionsReport {
    try await get("v2/corrections/report")
  }

  // MARK: - 内部

  private struct ErrorEnvelope: Decodable {
    struct Body: Decodable { let message: String }
    let error: Body
    let revision: Int?
  }

  private func makeRequest(_ path: String, method: String = "GET") -> URLRequest {
    var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
    return request
  }

  private func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
    let (data, _) = try await send(makeRequest(path))
    return try decode(T.self, from: data)
  }

  private func post<T: Decodable>(_ path: String) async throws -> T {
    let (data, _) = try await send(makeRequest(path, method: "POST"))
    return try decode(T.self, from: data)
  }

  private func sendJSON<Body: Encodable, T: Decodable>(_ path: String, method: String = "POST", body: Body) async throws -> T {
    var request = makeRequest(path, method: method)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do { request.httpBody = try JSONEncoder().encode(body) }
    catch { throw RecognitionClientError.invalidResponse }
    let (data, _) = try await send(request)
    return try decode(T.self, from: data)
  }

  /// 取图：必须是 image/jpeg 且字节以 JPEG 头开始，否则视为不可安全使用。
  private func image(_ path: String) async throws -> Data {
    try await image(makeRequest(path))
  }

  /// 取图（已构造的请求，供带查询参数的裁图用）。
  private func image(_ request: URLRequest) async throws -> Data {
    let (data, response) = try await send(request)
    guard response.mimeType == "image/jpeg", data.starts(with: [0xff, 0xd8, 0xff]), data.count <= 15_000_000 else {
      throw RecognitionClientError.invalidResponse
    }
    return data
  }

  private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try RecognitionCodec.decoder().decode(T.self, from: data) }
    catch { throw RecognitionClientError.invalidResponse }
  }

  private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) }
    catch is CancellationError { throw CancellationError() }
    catch let urlError as URLError { throw RecognitionClientError.networkFailure(urlError) }
    catch { throw RecognitionClientError.service("暂时连不上学习服务。请检查连接后重试。") }
    guard let http = response as? HTTPURLResponse, data.count <= 20_000_000 else { throw RecognitionClientError.invalidResponse }
    guard (200...299).contains(http.statusCode) else {
      let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
      let message = redact(envelope?.error.message ?? "学习服务暂时无法完成操作，请检查连接后重试。")
      // 修改接口的 409 顶层带当前 revision：单独错误类型带出，供刷新后重试。
      if http.statusCode == 409, let revision = envelope?.revision {
        throw V2ClientError.revisionConflict(message: message, currentRevision: revision)
      }
      throw RecognitionClientError.server(status: http.statusCode, message: message)
    }
    return (data, http)
  }

  /// 令牌与设备 ID 不进错误文案（脱敏）。
  private func redact(_ message: String) -> String {
    var text = message.replacingOccurrences(of: configuration.token, with: "[已隐藏]")
    if let deviceId = configuration.deviceId {
      text = text.replacingOccurrences(of: deviceId, with: "[设备已隐藏]")
    }
    return text
  }

  // MARK: - ID 形态校验（不合法直接失败，不发请求）

  /// itm_/pkt_/crp_ 前缀 + 16 位十六进制。
  private func validatePrefixedID(_ id: String, prefix: String) throws {
    guard id.hasPrefix(prefix) else { throw RecognitionClientError.invalidResponse }
    let hex = id.dropFirst(prefix.count)
    guard hex.count == 16, hex.allSatisfy(\.isHexDigit), hex.allSatisfy({ !$0.isLetter || $0.isLowercase }) else {
      throw RecognitionClientError.invalidResponse
    }
  }

  /// jobId 与 clientRequestId 是 UUID。
  private func validateUUID(_ value: String) throws {
    guard UUID(uuidString: value) != nil else { throw RecognitionClientError.invalidResponse }
  }

  /// 快照图片名：^[a-z0-9][a-z0-9.-]*\.jpg$
  private func validateMediaName(_ name: String) throws {
    guard name.count >= 5, name.hasSuffix(".jpg"),
      let first = name.first, first.isLowercaseASCIIOrDigit,
      name.allSatisfy({ $0.isLowercaseASCIIOrDigit || $0 == "." || $0 == "-" })
    else { throw RecognitionClientError.invalidResponse }
  }
}

private extension Character {
  var isLowercaseASCIIOrDigit: Bool {
    ("a"..."z").contains(self) || ("0"..."9").contains(self)
  }
}
