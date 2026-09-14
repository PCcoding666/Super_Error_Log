import Foundation

// A dedicated ephemeral session never follows redirects with the pairing credential.
final class RecognitionClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let configuration: PairingConfiguration
  private var session: URLSession!

  init(configuration: PairingConfiguration, sessionConfiguration: URLSessionConfiguration = .ephemeral) {
    self.configuration = configuration
    super.init()
    sessionConfiguration.timeoutIntervalForRequest = 25
    sessionConfiguration.timeoutIntervalForResource = 60
    sessionConfiguration.urlCache = nil
    sessionConfiguration.httpCookieStorage = nil
    session = URLSession(configuration: sessionConfiguration, delegate: self, delegateQueue: nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func close() { session.invalidateAndCancel() }

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
    return try await job(request)
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
  private func job(_ request: URLRequest) async throws -> RecognitionJob {
    let (data, _) = try await send(request)
    do {
      let job = try RecognitionCodec.decoder().decode(Envelope.self, from: data).job
      guard job.version == 1, job.revision > 0 else { throw RecognitionClientError.invalidResponse }
      try validateID(job.id)
      return job
    } catch { throw RecognitionClientError.invalidResponse }
  }
  private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) }
    catch is CancellationError { throw CancellationError() }
    catch { throw RecognitionClientError.service("暂时连不上本机服务。已保存的照片和结果仍可查看，请检查连接后重试。") }
    guard let http = response as? HTTPURLResponse, data.count <= 20_000_000 else { throw RecognitionClientError.invalidResponse }
    guard (200...299).contains(http.statusCode) else {
      let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error.message)
        ?? "本机服务暂时无法完成操作，请检查连接后重试。"
      throw RecognitionClientError.service(message.replacingOccurrences(of: configuration.token, with: "[已隐藏]"))
    }
    return (data, http)
  }
}
