import Foundation

/// 错题本页的筛选条件，字段和网页版 `/s/api/notebook` 的查询参数一致；空串表示不筛。
struct NotebookQuery: Equatable, Sendable {
  var subject = ""
  var grade = ""
  var chapter = ""
  var tag = ""
  var q = ""

  var items: [URLQueryItem] {
    [("subject", subject), ("grade", grade), ("chapter", chapter), ("tag", tag), ("q", q)]
      .filter { !$0.1.isEmpty }.map { URLQueryItem(name: $0.0, value: $0.1) }
  }
}

/// 上传失败的原因：`retryable` 决定界面给不给「再试一次」。文案面向学生，和网页版 uploader 一致。
struct UploadFailure: Error, LocalizedError, Equatable, Sendable {
  let message: String
  let retryable: Bool
  var errorDescription: String? { message }

  static let network = UploadFailure(message: "网络没连上，没传上去。照片还在这个页面里。", retryable: true)
  static let timeout = UploadFailure(message: "上传超时了。照片还在这个页面里，点「再试一次」。", retryable: true)
  static let generic = UploadFailure(message: "没传上去。过一会儿再试，照片还在这个页面里。", retryable: true)
}

/// 经网关 `/s/native/web/*` 读写网页版同一套接口（见 docs/ios-native-invitation-login.md）。
/// 只认邀请码登录得到的 Bearer 令牌；网关替 App 带内部 cookie，业务 cookie（如当前学科）由本会话的 cookie 罐保存。
/// 不跟随重定向（令牌不能被带到别处）；IP 入口走 CloudTLSPinning。
final class WebClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let configuration: PairingConfiguration
  private let pinning: CloudTLSPinning
  private var session: URLSession!

  init(configuration: PairingConfiguration, sessionConfiguration: URLSessionConfiguration = .ephemeral,
    pinning: CloudTLSPinning = .production) {
    self.configuration = configuration
    self.pinning = pinning
    super.init()
    sessionConfiguration.timeoutIntervalForRequest = 20
    sessionConfiguration.timeoutIntervalForResource = 300
    sessionConfiguration.urlCache = nil
    session = URLSession(configuration: sessionConfiguration, delegate: self, delegateQueue: nil)
  }

  func close() { session.invalidateAndCancel() }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let (disposition, credential) = pinning.disposition(for: challenge)
    completionHandler(disposition, credential)
  }

  // MARK: - 地址

  /// `/s/api/notebook` 这类网页路径 → 原生入口下的 `…/s/native/web/api/notebook`。不是 `/s/` 开头的路径返回 nil。
  func url(forServerPath path: String) -> URL? {
    guard path.hasPrefix("/s/") else { return nil }
    return URL(string: configuration.baseURL.absoluteString + "/web" + path.dropFirst(2))
  }

  private func apiURL(_ path: String, query: [URLQueryItem] = []) -> URL {
    var components = URLComponents(string: configuration.baseURL.absoluteString + "/web" + path)!
    if !query.isEmpty { components.queryItems = query }
    return components.url!
  }

  private func makeRequest(_ url: URL, method: String = "GET", accept: String = "application/json") -> URLRequest {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
    request.setValue(accept, forHTTPHeaderField: "Accept")
    return request
  }

  // MARK: - 传输

  private struct ErrorEnvelope: Decodable { struct Body: Decodable { let code: String?; let message: String? }; let error: Body? }

  private func perform(_ request: URLRequest, body: Data? = nil, delegate: URLSessionTaskDelegate? = nil,
    limit: Int = 20_000_000, allowRedirect: Bool = false) async throws -> (Data, HTTPURLResponse) {
    let data: Data
    let response: URLResponse
    do {
      if let body { (data, response) = try await session.upload(for: request, from: body, delegate: delegate) }
      else { (data, response) = try await session.data(for: request, delegate: delegate) }
    } catch is CancellationError { throw CancellationError() }
    catch let error as URLError where error.code == .cancelled { throw CancellationError() }
    catch let error as URLError { throw Self.transportError(error) }
    catch { throw WebAPIError.unreachable }
    guard let http = response as? HTTPURLResponse, data.count <= limit else { throw WebAPIError.badResponse }
    if allowRedirect, (300...399).contains(http.statusCode) { return (data, http) }
    guard (200...299).contains(http.statusCode) else {
      let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
      throw WebAPIError(status: http.statusCode, code: envelope?.error?.code ?? "http_\(http.statusCode)",
        message: envelope?.error?.message ?? (http.statusCode >= 500 ? "服务器暂时没准备好，过一会儿再试。" : "暂时连不上，稍后再试。"))
    }
    return (data, http)
  }

  static func transportError(_ error: URLError) -> WebAPIError {
    switch error.code {
    case .timedOut: WebAPIError(status: 0, code: "timeout", message: "等了太久没回应，稍后再试。")
    case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
      WebAPIError(status: 0, code: "network", message: "网络没连上，检查一下网络再试。")
    default: .unreachable
    }
  }

  private func decoded<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch { throw WebAPIError.badResponse }
  }

  private func getJSON<T: Decodable>(_ type: T.Type, _ path: String, query: [URLQueryItem] = []) async throws -> T {
    let (data, _) = try await perform(makeRequest(apiURL(path, query: query)))
    return try decoded(type, from: data)
  }

  private func postJSON<T: Decodable>(_ type: T.Type, _ path: String, body: [String: Any] = [:]) async throws -> T {
    var request = makeRequest(apiURL(path), method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let payload = try JSONSerialization.data(withJSONObject: body)
    let (data, _) = try await perform(request, body: payload)
    return try decoded(type, from: data)
  }

  private struct Ok: Decodable { let ok: Bool? }

  // MARK: - 错题本

  func notebook(_ query: NotebookQuery) async throws -> NotebookResponse {
    try await getJSON(NotebookResponse.self, "/api/notebook", query: query.items)
  }

  func item(id: String) async throws -> ItemDetailResponse {
    try await getJSON(ItemDetailResponse.self, "/api/items/\(id)")
  }

  func discard(ids: [String]) async throws -> DiscardResponse {
    try await postJSON(DiscardResponse.self, "/api/items/discard", body: ["ids": ids])
  }

  func restore(id: String) async throws {
    _ = try await postJSON(Ok.self, "/api/items/\(id)/restore")
  }

  func category(id: String, grade: String, subject: String, chapter: String) async throws {
    _ = try await postJSON(Ok.self, "/api/items/\(id)/category", body: ["grade": grade, "subject": subject, "chapter": chapter])
  }

  // MARK: - 设置

  func settings() async throws -> SettingsResponse {
    try await getJSON(SettingsResponse.self, "/api/settings")
  }

  func setGrade(_ grade: String) async throws {
    _ = try await postJSON(Ok.self, "/api/settings/grade", body: ["grade": grade])
  }

  // MARK: - 录入态

  func intake() async throws -> IntakeResponse {
    try await getJSON(IntakeResponse.self, "/api/intake")
  }

  func uploadMode() async throws -> UploadModeResponse {
    try await getJSON(UploadModeResponse.self, "/api/upload")
  }

  func select(photoID: String, ids: [String]) async throws {
    _ = try await postJSON(Ok.self, "/api/intake/photos/\(photoID)/select", body: ["ids": ids])
  }

  func retry(photoID: String) async throws {
    _ = try await postJSON(Ok.self, "/api/intake/photos/\(photoID)/retry")
  }

  func dismiss(photoID: String) async throws {
    _ = try await postJSON(Ok.self, "/api/intake/photos/\(photoID)/dismiss")
  }

  // MARK: - 图片

  /// 缩略图、裁图、整页照片：服务端路径（`/s/img/…`）→ 原始字节。
  /// 网页的 `/s/img/item/…` 会 303 到真正的裁图 / 原图（`/s/materials/…`）：这里不让系统自动跟（令牌不能被带去别处），
  /// 只在 Location 仍是 `/s/` 开头的站内路径时，自己换成原生入口的地址再取，最多跟三次。
  func imageData(serverPath: String) async throws -> Data {
    var path = serverPath
    for _ in 0..<4 {
      guard let url = url(forServerPath: path) else { throw WebAPIError.badResponse }
      let (data, http) = try await perform(makeRequest(url, accept: "image/*"), limit: 40_000_000, allowRedirect: true)
      guard (300...399).contains(http.statusCode) else { return data }
      guard let location = http.value(forHTTPHeaderField: "Location"), location.hasPrefix("/s/") else { throw WebAPIError.badResponse }
      path = location
    }
    throw WebAPIError.badResponse
  }

  // MARK: - 上传（流程和字段对照 client/src/lib/uploader.ts）

  /// 旧识别流程：`POST /capture`（表单 key + photo）→ jobId。
  func uploadLegacy(key: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    var form = MultipartForm()
    form.addField("key", key)
    form.addFile("photo", filename: "photo.jpg", mimeType: "image/jpeg", data: jpeg)
    struct Result: Decodable { let ok: Bool?; let jobId: String? }
    let result = try await sendUpload(Result.self, path: "/capture", form: form, headers: [:], progress: progress)
    guard result.ok == true, let id = result.jobId, !id.isEmpty else { throw UploadFailure.generic }
    return id
  }

  /// 材料流程第一步：为这一批照片建一次 capture（同一 requestId 重放返回同一个）。
  func createMaterialsCapture(namespace: String, requestID: String) async throws -> String {
    var request = makeRequest(apiURL("/materials/captures"), method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(namespace, forHTTPHeaderField: "X-Draft-Namespace")
    let payload = try JSONSerialization.data(withJSONObject: ["requestId": requestID])
    do {
      let (data, _) = try await perform(request, body: payload)
      struct Created: Decodable { let id: String? }
      guard let id = try? JSONDecoder().decode(Created.self, from: data).id, !id.isEmpty else { throw UploadFailure.generic }
      return id
    } catch let error as WebAPIError {
      throw UploadFailure(message: error.message, retryable: error.status == 0 || error.status >= 500 || error.status == 429)
    }
  }

  /// 材料流程第二步：`POST /materials/uploads`（表单 captureId + hints + photo）→ assetId。
  func uploadMaterials(namespace: String, captureID: String, uploadID: String, jpeg: Data,
    progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    var form = MultipartForm()
    form.addField("captureId", captureID)
    form.addField("hints", "{}")
    form.addFile("photo", filename: "photo.jpg", mimeType: "image/jpeg", data: jpeg)
    struct Result: Decodable { struct Job: Decodable { let id: String?; let kind: String? }; let ok: Bool?; let assetId: String?; let job: Job? }
    let result = try await sendUpload(Result.self, path: "/materials/uploads", form: form,
      headers: ["X-Draft-Namespace": namespace, "X-Upload-Id": uploadID], progress: progress)
    guard result.ok == true, let id = result.assetId, !id.isEmpty, result.job?.kind == "extract" else { throw UploadFailure.generic }
    return id
  }

  private func sendUpload<T: Decodable>(_ type: T.Type, path: String, form: MultipartForm, headers: [String: String],
    progress: @escaping @Sendable (Double) -> Void) async throws -> T {
    var request = makeRequest(apiURL(path), method: "POST")
    request.timeoutInterval = 120
    request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let delegate = UploadProgress(progress)
    do {
      let (data, _) = try await perform(request, body: form.body, delegate: delegate)
      guard let value = try? JSONDecoder().decode(type, from: data) else { throw UploadFailure.generic }
      return value
    } catch let error as WebAPIError {
      switch error.code {
      case "timeout": throw UploadFailure.timeout
      case "network": throw UploadFailure.network
      default:
        // 服务器给了说明的 4xx/5xx 直接用它的话；图片本身有问题（400 / invalid_image）不给重试。
        let hasServerMessage = error.status != 0 && !error.code.hasPrefix("http_")
        if hasServerMessage { throw UploadFailure(message: error.message, retryable: error.status != 400 && error.code != "invalid_image") }
        throw UploadFailure(message: UploadFailure.generic.message, retryable: true)
      }
    }
  }

  private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let handler: @Sendable (Double) -> Void
    init(_ handler: @escaping @Sendable (Double) -> Void) { self.handler = handler }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
      totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
      guard totalBytesExpectedToSend > 0 else { return }
      handler(min(1, max(0, Double(totalBytesSent) / Double(totalBytesExpectedToSend))))
    }
  }
}

/// 最小的 multipart/form-data 构造（一张照片 + 几个文本字段，整体在内存里，≤ 15 MB）。
struct MultipartForm {
  let boundary = "sel-" + UUID().uuidString
  private var parts = Data()

  var contentType: String { "multipart/form-data; boundary=\(boundary)" }
  /// 加完所有字段后取：自带结尾边界。
  var body: Data { parts + Data("--\(boundary)--\r\n".utf8) }

  mutating func addField(_ name: String, _ value: String) {
    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
  }

  mutating func addFile(_ name: String, filename: String, mimeType: String, data: Data) {
    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mimeType)\r\n\r\n")
    parts.append(data)
    append("\r\n")
  }

  private mutating func append(_ text: String) { parts.append(Data(text.utf8)) }
}
