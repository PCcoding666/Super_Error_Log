import Foundation
import Darwin
import UIKit

// Test-only HTTP server. Binds loopback on an OS-assigned port. Never forwards to a model.
final class SyntheticRecognitionServer: @unchecked Sendable {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let questionID = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let token = "synthetic-pairing-only"
  static let cloudServiceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let cloudDeviceId = "8b411cca-f903-4d8c-a5d0-41435e2a66bb"
  static let cloudDeviceToken = "synthetic-device-token-32-bytes-test!"

  /// Task 5：云端语义的合成 health 行为（供 `-cloud-loopback` DEBUG 注入路径消费）。
  enum CloudHealth {
    case accepting, busy, unauthorized, rateLimited
    var acceptingJobs: Bool { self == .accepting }
  }

  private let descriptor: Int32
  let port: UInt16
  private let lock = NSLock()
  private var stopped = false
  private var confirmed = false
  private var count = 0
  private var uploads = 0
  private var recoveries = 0
  private var redeems = 0
  private let image: Data
  let needsCheck: Bool
  let requiresDiagram: Bool
  let printedStem: String
  let recoveryFailure: Bool
  let cloudHealth: CloudHealth?
  var requestCount: Int { lock.withLock { count } }
  var uploadCount: Int { lock.withLock { uploads } }
  var recoveryCount: Int { lock.withLock { recoveries } }
  var redeemCount: Int { lock.withLock { redeems } }

  @MainActor init(needsCheck: Bool = false, longStem: Bool = false, recoveryFailure: Bool = false,
    cloudHealth: CloudHealth? = nil) throws {
    self.recoveryFailure = recoveryFailure
    self.needsCheck = needsCheck
    self.cloudHealth = cloudHealth
    requiresDiagram = longStem
    printedStem = longStem
      ? "合成测试长题干\n" + (1...65).map { "第\($0)小问：已知 x + 3 = 5，求 x 的值。" }.joined(separator: "\n")
      : "合成测试题：求 x 的值。\nx + 3 = 5。"
    image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 80)).jpegData(withCompressionQuality: 0.9) { context in
      UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 80))
      ("合成测试图示" as NSString).draw(at: CGPoint(x: 5, y: 30), withAttributes: [.font: UIFont.systemFont(ofSize: 12)])
    }
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    descriptor = socketFD
    guard socketFD >= 0 else { throw NSError(domain: "SyntheticHTTP", code: 1) }
    var reuse: Int32 = 1
    setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0, listen(socketFD, 8) == 0 else { close(socketFD); throw NSError(domain: "SyntheticHTTP", code: 2) }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socketFD, $0, &length) }
    }
    port = UInt16(bigEndian: address.sin_port)
    DispatchQueue(label: "SyntheticRecognitionHTTP").async { [weak self] in self?.serve() }
  }

  func stop() {
    let alreadyStopped = lock.withLock { let previous = stopped; stopped = true; return previous }
    guard !alreadyStopped else { return }
    shutdown(descriptor, SHUT_RDWR); close(descriptor)
  }

  private func serve() {
    while !lock.withLock({ stopped }) {
      let connection = accept(descriptor, nil, nil)
      if connection < 0 { return }
      var noSignal: Int32 = 1
      setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
      var timeout = timeval(tv_sec: 10, tv_usec: 0)
      setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
      exchange(connection)
      close(connection)
    }
  }

  private func exchange(_ descriptor: Int32) {
    var input = Data()
    var header: String?
    var bodyStart = 0
    var contentLength = 0
    var buffer = [UInt8](repeating: 0, count: 65536)
    while input.count < 16_000_000 {
      let size = recv(descriptor, &buffer, buffer.count, 0)
      if size <= 0 { return }
      input.append(buffer, count: size)
      if header == nil, let range = input.range(of: Data("\r\n\r\n".utf8)) {
        header = String(data: input[..<range.lowerBound], encoding: .utf8)
        bodyStart = range.upperBound
        for line in (header ?? "").components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-length:") {
          contentLength = Int(line.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)) ?? 0
        }
      }
      if header != nil && input.count >= bodyStart + contentLength { break }
    }
    guard let header, let requestLine = header.components(separatedBy: "\r\n").first else { return }
    lock.withLock { count += 1 }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return }
    let path = String(parts[1])

    // Task 5：云端语义入口（DEBUG `-cloud-loopback` 注入路径）。仅当构造时给出 cloudHealth
    // 才启用；回环配对路径完全不受影响。
    if let cloudHealth {
      let authorized = header.lowercased().contains("authorization: bearer " + Self.cloudDeviceToken)
      if path == "/v1/pairing/redeem", parts[0] == "POST" {
        lock.withLock { redeems += 1 }
        let body = #"{"token":"\#(Self.cloudDeviceToken)","deviceId":"\#(Self.cloudDeviceId)","serviceId":"\#(Self.cloudServiceId)","expiresAt":"2026-10-17T00:00:00.000Z","protocolVersion":1}"#
        respond(descriptor, data: Data(body.utf8))
        return
      }
      if path == "/v1/health" {
        switch cloudHealth {
        case .accepting, .busy:
          respond(descriptor, data: Data(#"{"version":1,"serviceId":"\#(Self.cloudServiceId)","storageAvailable":true,"visionConfigured":true,"acceptingJobs":\#(cloudHealth.acceptingJobs),"protocolVersion":1}"#.utf8))
        case .unauthorized:
          respond(descriptor, data: Data(#"{"error":{"code":"unauthorized","message":"设备令牌无效。"}}"#.utf8), status: 401)
        case .rateLimited:
          respond(descriptor, data: Data(#"{"error":{"code":"rate_limited","message":"请求过于频繁，请稍后再试。"}}"#.utf8), status: 429)
        }
        return
      }
      if !authorized {
        respond(descriptor, data: Data(#"{"error":{"code":"unauthorized","message":"设备令牌无效。"}}"#.utf8), status: 401)
        return
      }
      if parts[0] == "POST", path == "/v1/recognitions" { lock.withLock { uploads += 1 } }
      let envelope: [String: Any] = ["job": cloudJob()]
      guard let data = try? JSONSerialization.data(withJSONObject: envelope) else { return }
      respond(descriptor, data: data)
      return
    }

    if parts[0] == "POST", path == "/v1/recognitions" { lock.withLock { uploads += 1 } }
    guard header.lowercased().contains("authorization: bearer " + Self.token) else {
      respond(descriptor, data: Data(#"{"error":{"message":"合成测试配对失败"}}"#.utf8), status: 401)
      return
    }
    if path.contains("/media/") { respond(descriptor, data: image, mime: "image/jpeg"); return }
    if path.hasSuffix("/confirm") { lock.withLock { confirmed = true } }
    if path.hasSuffix("/retry"), parts[0] == "POST" { lock.withLock { recoveries += 1 } }
    let accepted = lock.withLock { confirmed }
    let failed = recoveryFailure && recoveryCount == 0
    let status = failed ? "failed" : accepted ? "confirmed" : needsCheck ? "needs_check" : "ready"
    let question: [String: Any] = [
      "id": Self.questionID, "number": "合成1", "revision": accepted ? 5 : recoveryCount > 0 ? 4 : 3,
      "status": status, "selectionEvidence": "corrected",
      "candidateBox": ["x": 0.6, "y": 0.1, "width": 0.3, "height": 0.7],
      "evidence": ["version": 1, "questionNumber": "合成1", "questionText": printedStem, "subject": "数学", "chapter": "", "knowledgeTags": ["合成测试"], "questionType": "计算",
        "questionRegion": ["x": 0.1, "y": 0.1, "width": 0.8, "height": 0.7],
        "requiresDiagram": requiresDiagram, "regions": requiresDiagram ? [["id": "d1", "kind": "diagram", "box": ["x": 0.1, "y": 0.1, "width": 0.4, "height": 0.4], "confidence": 0.9, "cleanForPrint": false]] : [], "observations": [["id": "o1", "kind": "correction", "text": "合成订正内容，不进入 PDF", "regionId": NSNull(), "confidence": 0.8]],
        "uncertainties": needsCheck ? ["合成测试：此处看不清"] : []] as [String: Any],
      "verification": ["textComplete": !needsCheck, "questionCropComplete": !needsCheck, "questionCropPure": !needsCheck, "transcriptionMatches": !needsCheck, "diagramSafe": true, "issues": needsCheck ? ["合成测试：此处看不清"] : []] as [String: Any],
      "questionMediaId": "1800c1bc-47ab-42bc-a46d-315005bdc695", "diagramMediaIds": requiresDiagram ? ["cd8e4781-766b-4fb5-b0d3-3ba6c2ed42a0"] : [],
      "error": failed ? ["code": "invalid_output", "message": "合成结构检查失败，请修复后恢复", "stage": "verify", "retryable": false, "recoverable": true] as [String: Any] : NSNull(), "confirmedAt": accepted ? "2026-09-14T10:01:30.000Z" : NSNull(),
    ]
    let job: [String: Any] = ["version": 1, "id": Self.jobID, "revision": accepted ? 10 : recoveryCount > 0 ? 9 : 8,
      "photoName": "合成测试照片.jpg", "sourceHash": "synthetic", "sourceMediaId": "6ddc034b-b0f8-4288-b9c1-4f496cfb90df",
      "status": failed ? "failed" : needsCheck ? "partial" : "completed", "phase": "complete", "inventoryWarnings": [],
      "questions": [question], "error": NSNull(), "createdAt": "2026-09-14T10:00:00.000Z", "updatedAt": "2026-09-14T10:01:30.000Z"]
    let envelope: [String: Any] = parts[0] == "GET" && path == "/v1/recognitions" ? ["jobs": [job]] : ["job": job]
    guard let data = try? JSONSerialization.data(withJSONObject: envelope) else { return }
    respond(descriptor, data: data)
  }

  private func respond(_ descriptor: Int32, data: Data, status: Int = 200, mime: String = "application/json") {
    var response = Data("HTTP/1.1 \(status) OK\r\nContent-Type: \(mime)\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n".utf8)
    response.append(data)
    response.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let sent = send(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset, 0)
        if sent <= 0 { return }
        offset += sent
      }
    }
  }

  /// Task 5：云端语义的合成 job（与回环 fixture 同形，仅字段语义不同）。
  private func cloudJob() -> [String: Any] {
    let question: [String: Any] = [
      "id": Self.questionID, "number": "云1", "revision": 3, "status": "ready", "selectionEvidence": "corrected",
      "evidence": ["version": 1, "questionNumber": "云1", "questionText": printedStem, "subject": "数学", "chapter": "", "knowledgeTags": ["合成测试"], "questionType": "计算",
        "questionRegion": ["x": 0.1, "y": 0.1, "width": 0.8, "height": 0.7], "requiresDiagram": false, "regions": [], "observations": [], "uncertainties": []] as [String: Any],
      "verification": ["textComplete": true, "questionCropComplete": true, "questionCropPure": true, "transcriptionMatches": true, "diagramSafe": true, "issues": []] as [String: Any],
      "questionMediaId": "1800c1bc-47ab-42bc-a46d-315005bdc695", "diagramMediaIds": [], "error": NSNull(), "confirmedAt": NSNull(),
    ]
    return ["version": 1, "id": Self.jobID, "revision": 8, "photoName": "合成测试照片.jpg",
      "sourceHash": "synthetic", "sourceMediaId": "6ddc034b-b0f8-4288-b9c1-4f496cfb90df",
      "status": "completed", "phase": "complete", "inventoryWarnings": [], "questions": [question],
      "error": NSNull(), "createdAt": "2026-09-14T10:00:00.000Z", "updatedAt": "2026-09-14T10:01:30.000Z"]
  }
}
