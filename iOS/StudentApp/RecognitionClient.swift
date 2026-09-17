import Foundation

// A dedicated ephemeral session never follows redirects with the pairing credential.
// Task 4: dual-mode (loopback token / cloud device token), health check, redeem,
// and per-purpose timeouts: checks 15s, uploads 180s.
final class RecognitionClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let configuration: PairingConfiguration
  private var session: URLSession!
  private var uploadSession: URLSession!

  init(configuration: PairingConfiguration, sessionConfiguration: URLSessionConfiguration = .ephemeral) {
    self.configuration = configuration
    super.init()
    sessionConfiguration.timeoutIntervalForRequest = 15
    sessionConfiguration.timeoutIntervalForResource = 60
    sessionConfiguration.urlCache = nil
    sessionConfiguration.httpCookieStorage = nil
    session = URLSession(configuration: sessionConfiguration, delegate: self, delegateQueue: nil)
    let uploadConfiguration = sessionConfiguration.copy() as! URLSessionConfiguration
    uploadConfiguration.timeoutIntervalForRequest = 180
    uploadConfiguration.timeoutIntervalForResource = 300
    uploadSession = URLSession(configuration: uploadConfiguration, delegate: self, delegateQueue: nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    // 云端入口只接受固定域名；任何重定向（可能携带凭据）一律拒绝。
    completionHandler(nil)
  }

  func close() { session.invalidateAndCancel(); uploadSession.invalidateAndCancel() }

  // MARK: - Task 4: health check & redeem

  /// 已鉴权健康检查（GET /v1/health）。云端模式下同时是归属校验：
  /// 返回的 serviceId 必须与配对一致，否则视为不兼容。
  func health() async throws -> HealthSnapshot {
    let (data, _) = try await send(makeRequest("v1/health"))
    let snapshot: HealthSnapshot
    do { snapshot = try RecognitionCodec.decoder().decode(HealthSnapshot.self, from: data) }
    catch { throw RecognitionClientError.invalidResponse }
    if let expected = configuration.serviceId, snapshot.serviceId != expected {
      throw RecognitionClientError.service("健康检查返回的服务与配对不一致，请重新配对。")
    }
    return snapshot
  }

  /// 兑换配对码（POST /v1/pairing/redeem）——唯一免鉴权入口。
  /// 按相同 clientId 幂等重试：服务端同 clientId + 同 secret 返回相同结果。
  func redeem(qr: CloudPairing.ParsedQR, clientId: String, deviceInfo: String) async throws -> RedeemResult {
    guard configuration.isCloud else { throw RecognitionClientError.invalidPairing }
    var request = makeRequest("v1/pairing/redeem", method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // 本方法在配对令牌就位前调用：不携带 Authorization 头。
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    let body: [String: Any] = [
      "payload": ["v": qr.v, "serviceId": qr.serviceId, "httpsUrl": qr.httpsUrl,
        "sessionId": qr.sessionId, "secret": qr.secret],
      "clientId": clientId,
      "deviceInfo": deviceInfo,
    ]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, http) = try await send(request, authenticated: false)
    do {
      return try RecognitionCodec.decoder().decode(RedeemResult.self, from: data)
    } catch { throw RecognitionClientError.invalidResponse }
  }

  // MARK: - Existing job operations

  func upload(file: URL, idempotencyKey: UUID, photoName: String) async throws -> RecognitionJob {
    let data = try await Task.detached { try Data(contentsOf: file) }.value
    guard data.count <= 15_000_000, data.starts(with: [0xff, 0xd8, 0xff]) else {
      throw RecognitionClientError.service("上传副本需要是小于 15 MB 的 JPEG 图片。")
    }
    var request = makeRequest("v1/recognitions", method: "POST")
    request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
    request.setValue(idempotencyKey.uuidString, forHTTPHeaderField: "Idempotency-Key")
    request.setValue(photoName.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: ".-_"))), forHTTPHeaderField: "X-Photo-Name")
    request.httpBody = data
    return try await job(request, via: uploadSession)
  }

  func getJob(_ id: String) async throws -> RecognitionJob {
    try validateID(id)
    return try await job(makeRequest("v1/recognitions/\(id)"))
  }

  func listJobs() async throws -> [RecognitionJob] {
    struct Collection: Decodable { let jobs: [RecognitionJob] }
    let (data, _) = try await send(makeRequest("v1/recognitions"))
    do {
      let jobs = try RecognitionCodec.decoder().decode(Collection.self, from: data).jobs
      for job in jobs {
        guard job.version == 1, job.revision > 0 else { throw RecognitionClientError.invalidResponse }
        try validateID(job.id); try validateID(job.sourceMediaId)
      }
      return jobs
    } catch { throw RecognitionClientError.invalidResponse }
  }

  func retry(_ id: String, questionID: String?) async throws -> RecognitionJob {
    try validateID(id)
    if let questionID { try validateID(questionID) }
    var request = makeRequest("v1/recognitions/\(id)/retry", method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["questionId": questionID as Any? ?? NSNull()])
    return try await job(request)
  }

  func confirm(_ id: String, question: RecognitionQuestion, skip: Bool, sourceCompared: Bool) async throws -> RecognitionJob {
    try validateID(id); try validateID(question.id)
    guard skip ? !question.active : question.status == "ready" && question.canAccept && sourceCompared
    else { throw StudyError.selectionNotReady }
    var request = makeRequest("v1/recognitions/\(id)/questions/\(question.id)/confirm", method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["revision": question.revision,
      "action": skip ? "skip" : "confirm", "sourceCompared": sourceCompared])
    return try await job(request)
  }

  func media(_ id: String, mediaID: String) async throws -> Data {
    try validateID(id); try validateID(mediaID)
    let (data, response) = try await send(makeRequest("v1/recognitions/\(id)/media/\(mediaID)"))
    guard response.mimeType == "image/jpeg", data.starts(with: [0xff, 0xd8, 0xff]), data.count <= 15_000_000 else {
      throw RecognitionClientError.invalidResponse
    }
    return data
  }

  private func validateID(_ id: String) throws {
    guard UUID(uuidString: id) != nil else { throw RecognitionClientError.invalidResponse }
  }
  private func makeRequest(_ path: String, method: String = "GET") -> URLRequest {
    var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
    return request
  }
  private struct Envelope: Decodable { let job: RecognitionJob }
  private struct ErrorEnvelope: Decodable { struct Body: Decodable { let message: String }; let error: Body }
  private func job(_ request: URLRequest, via session: URLSession? = nil) async throws -> RecognitionJob {
    let (data, _) = try await send(request, via: session)
    do {
      let job = try RecognitionCodec.decoder().decode(Envelope.self, from: data).job
      guard job.version == 1, job.revision > 0 else { throw RecognitionClientError.invalidResponse }
      try validateID(job.id)
      return job
    } catch { throw RecognitionClientError.invalidResponse }
  }
  private func send(_ request: URLRequest, via session: URLSession? = nil, authenticated: Bool = true) async throws -> (Data, HTTPURLResponse) {
    let data: Data
    let response: URLResponse
    do { (data, response) = try await (session ?? self.session).data(for: request) }
    catch is CancellationError { throw CancellationError() }
    catch { throw RecognitionClientError.service("暂时连不上识别服务。已保存的照片和结果仍可查看，请检查连接后重试。") }
    guard let http = response as? HTTPURLResponse, data.count <= 20_000_000 else { throw RecognitionClientError.invalidResponse }
    guard (200...299).contains(http.statusCode) else {
      let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error.message)
        ?? "识别服务暂时无法完成操作，请检查连接后重试。"
      throw RecognitionClientError.service(redact(message))
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
}

/// Task 4: redeem 响应（服务端 RedeemResult 契约）。
struct RedeemResult: Codable, Equatable, Sendable {
  let token: String
  let deviceId: String
  let serviceId: String
  let expiresAt: Date
  let protocolVersion: Int

  enum CodingKeys: String, CodingKey { case token, deviceId, serviceId, expiresAt, protocolVersion }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    token = try values.decode(String.self, forKey: .token)
    deviceId = try values.decode(String.self, forKey: .deviceId)
    serviceId = try values.decode(String.self, forKey: .serviceId)
    expiresAt = try values.decode(Date.self, forKey: .expiresAt)
    protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
    guard protocolVersion == 1,
      UUID(uuidString: serviceId) != nil, UUID(uuidString: deviceId) != nil,
      token.count >= 16, !token.contains("\n"), !token.contains("\r")
    else { throw RecognitionClientError.invalidResponse }
  }
}
