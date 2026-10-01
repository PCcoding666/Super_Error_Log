import Foundation
import Darwin
import UIKit

// Test-only HTTP server. Binds loopback on an OS-assigned port. Never forwards to a model.
// T6f：云端语义（`-cloud-loopback` 注入路径）+ 完整 /v2 闭环（docs/mobile-v2-api.md 的形状）。
// 内部维护一小份状态：上传任务（识别进度两段式）、登记照片、题目、练习、打印准备（轮询两次就绪）、
// 追问轮次、识别结果版本号、回传与回报。裁图与打印图片返回一张合成 JPEG。
final class SyntheticRecognitionServer: @unchecked Sendable {
  static let cloudServiceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let cloudDeviceId = "8b411cca-f903-4d8c-a5d0-41435e2a66bb"
  static let cloudDeviceToken = "synthetic-device-token-32-bytes-test!"

  /// 云端语义的合成 health 行为（供 `-cloud-loopback` DEBUG 注入路径消费）。
  enum CloudHealth {
    case accepting, busy, unauthorized, rateLimited
    var acceptingJobs: Bool { self == .accepting }
  }

  // MARK: - /v2 状态（锁保护）

  private struct JobState {
    let id: String
    var polls = 0
    var registeredAt: String?
    /// 识别进度两段式：前两次轮询仍在识别，之后 completed（终态）。
    var terminal: Bool { polls >= 2 }
  }

  private struct ItemState {
    let id: String
    let shortId: String
    var subject: String
    var knowledgeTags: [String]
    var questionText: String
    var badge = "ok"
    var status = "ready_for_reflection"
    let jobId: String
    var revision = 1
    var reflected = false
    /// 追问：当前待回答问题（幂等续取）。
    var pendingQuestion: String?
    var suggestion: (summary: String, cause: String, attemptState: String)?
    var reflection: [String: Any]?
  }

  private struct ReturnRecord {
    let completion: String
    let correct: Bool?
    let toStatus: String
    let reason: String
  }

  private struct PacketState {
    let id: String
    var itemIds: [String]
    let practiceSlot: String
    let createdAt: String
    var generatedAt: String?
    var printPolls = 0
    var returned: [String: ReturnRecord] = [:]
  }

  private struct ProposalState {
    let id: String
    let itemId: String
    let revision: Int
    let changes: [[String: Any]]
  }

  private let descriptor: Int32
  let port: UInt16
  private let lock = NSLock()
  private var stopped = false
  private var count = 0
  private var uploads = 0
  private var redeems = 0
  private var jobs: [JobState] = []
  private var items: [ItemState] = []
  private var packets: [PacketState] = []
  private var proposals: [ProposalState] = []
  private var proposalCounter = 0
  private var practiceSlotSetting = "本周内"
  private var paperLocationSetting = "varies"
  private let image: Data
  let cloudHealth: CloudHealth
  var requestCount: Int { lock.withLock { count } }
  var uploadCount: Int { lock.withLock { uploads } }
  var redeemCount: Int { lock.withLock { redeems } }

  @MainActor init(cloudHealth: CloudHealth = .accepting) throws {
    self.cloudHealth = cloudHealth
    image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 72)).jpegData(withCompressionQuality: 0.9) { context in
      UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 72))
      ("合成测试裁图" as NSString).draw(at: CGPoint(x: 8, y: 28), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
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

  // MARK: - 连接处理

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
    let method = String(parts[0])
    let rawPath = String(parts[1])
    let path = String(rawPath.split(separator: "?", maxSplits: 1).first ?? "")
    let body = input.count > bodyStart ? Data(input[bodyStart...]) : Data()

    // 云端语义入口（DEBUG `-cloud-loopback` 注入路径）。
    if path == "/v1/pairing/redeem", method == "POST" {
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
    let authorized = header.lowercased().contains("authorization: bearer " + Self.cloudDeviceToken)
    guard authorized else {
      respond(descriptor, data: Data(#"{"error":{"code":"unauthorized","message":"设备令牌无效。"}}"#.utf8), status: 401)
      return
    }
    if path.hasPrefix("/v2/") {
      handleV2(descriptor, method: method, path: path, body: body)
      return
    }
    if method == "POST", path == "/v1/recognitions" {
      let job = lock.withLock { () -> JobState in
        uploads += 1
        let job = JobState(id: UUID().uuidString)
        jobs.append(job)
        return job
      }
      respond(descriptor, data: Data(#"{"job":\#(jobJSON(job))}"#.utf8))
      return
    }
    if method == "GET", path.hasPrefix("/v1/recognitions/") {
      if path.contains("/media/") { respond(descriptor, data: image, mime: "image/jpeg"); return }
      let id = String(path.dropFirst("/v1/recognitions/".count))
      let job = lock.withLock { () -> JobState? in
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return nil }
        jobs[index].polls += 1
        return jobs[index]
      }
      guard let job else {
        respond(descriptor, data: Data(#"{"error":{"code":"not_found","message":"识别任务不存在。"}}"#.utf8), status: 404)
        return
      }
      respond(descriptor, data: Data(#"{"job":\#(jobJSON(job))}"#.utf8))
      return
    }
    respond(descriptor, data: Data(#"{"error":{"code":"not_found","message":"接口不存在。"}}"#.utf8), status: 404)
  }

  // MARK: - /v1 识别任务（两段式进度：前两次轮询 processing，之后 completed）

  private func jobJSON(_ job: JobState) -> String {
    let terminal = job.terminal
    let status = terminal ? "completed" : "processing"
    let phase = terminal ? "complete" : "inventory"
    // revision 随轮询递增：客户端拒绝同 revision 的内容变化（防旧快照覆盖），进度推进必须升版本。
    let revision = 8 + job.polls
    return #"{"version":1,"id":"\#(job.id)","revision":\#(revision),"photoName":"合成测试照片.jpg","sourceHash":"synthetic","sourceMediaId":"6ddc034b-b0f8-4288-b9c1-4f496cfb90df","status":"\#(status)","phase":"\#(phase)","inventoryWarnings":[],"questions":[],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#
  }

  // MARK: - /v2 路由

  private func handleV2(_ descriptor: Int32, method: String, path: String, body: Data) {
    let segments = path.split(separator: "/").map(String.init)
    // /v2/health
    if path == "/v2/health" {
      respondJSON(descriptor, ["protocolVersion": 2])
      return
    }
    // /v2/photos/:jobId/register
    if method == "POST", segments.count == 4, segments[1] == "photos", segments[3] == "register" {
      registerPhoto(descriptor, jobId: segments[2])
      return
    }
    // /v2/week
    if method == "GET", path == "/v2/week" { weekView(descriptor); return }
    // /v2/settings
    if path == "/v2/settings" {
      if method == "GET" {
        respondJSON(descriptor, ["practiceSlot": lock.withLock { practiceSlotSetting },
          "paperLocation": lock.withLock { paperLocationSetting }])
        return
      }
      if method == "PUT", let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
        let slot = json["practiceSlot"] as? String, let location = json["paperLocation"] as? String {
        lock.withLock { practiceSlotSetting = slot; paperLocationSetting = location }
        respondJSON(descriptor, ["practiceSlot": slot, "paperLocation": location])
        return
      }
      respondError(descriptor, status: 400, code: "invalid_request", message: "请求正文不合法。")
      return
    }
    // /v2/practice/recommend
    if method == "GET", path == "/v2/practice/recommend" { recommend(descriptor); return }
    // /v2/practice（建练习 / 列表）
    if path == "/v2/practice" {
      if method == "POST" { createPractice(descriptor, body: body); return }
      if method == "GET" { practiceList(descriptor); return }
    }
    // /v2/corrections/report（合成：固定空报告）
    if method == "GET", path == "/v2/corrections/report" {
      respondJSON(descriptor, ["weeks": [[String: Any]]()])
      return
    }
    // /v2/practice/:id[/...]
    if segments.count >= 3, segments[1] == "practice" {
      let id = segments[2]
      if segments.count == 3, method == "GET" { practiceDetail(descriptor, id: id); return }
      if segments.count == 4, segments[3] == "print" {
        if method == "POST" { requestPrint(descriptor, id: id); return }
        if method == "GET" { printStatus(descriptor, id: id); return }
      }
      if segments.count == 6, segments[3] == "print", segments[4] == "media", method == "GET" {
        respond(descriptor, data: image, mime: "image/jpeg")
        return
      }
      if segments.count == 4, segments[3] == "return", method == "POST" { returnResults(descriptor, id: id, body: body); return }
      if segments.count == 4, segments[3] == "summary", method == "GET" { practiceSummary(descriptor, id: id); return }
    }
    // /v2/items/:id[/...]
    if segments.count >= 3, segments[1] == "items" {
      let id = segments[2]
      if segments.count == 4, segments[3] == "crop", method == "GET" {
        guard lock.withLock({ items.contains { $0.id == id } }) else {
          respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
          return
        }
        respond(descriptor, data: image, mime: "image/jpeg")
        return
      }
      if segments.count == 4, segments[3] == "discard", method == "POST" { setItemStatus(descriptor, id: id, status: "archived_not_worth_review"); return }
      if segments.count == 4, segments[3] == "restore", method == "POST" { setItemStatus(descriptor, id: id, status: "ready_for_reflection"); return }
      if segments.count == 4, segments[3] == "evidence", method == "GET" { evidence(descriptor, id: id); return }
      if segments.count == 4, segments[3] == "correct", method == "POST" { proposeCorrection(descriptor, id: id, body: body); return }
      if segments.count == 5, segments[3] == "correct", segments[4] == "accept", method == "POST" { acceptCorrection(descriptor, id: id, body: body); return }
      if segments.count == 5, segments[3] == "correct", segments[4] == "direct", method == "POST" { directCorrection(descriptor, id: id, body: body); return }
      if segments.count == 5, segments[3] == "reflection", segments[4] == "ask", method == "POST" { askReflection(descriptor, id: id); return }
      if segments.count == 5, segments[3] == "reflection", segments[4] == "answer", method == "POST" { answerReflection(descriptor, id: id, body: body); return }
      if segments.count == 4, segments[3] == "reflection", method == "POST" { submitReflection(descriptor, id: id, body: body); return }
      if segments.count == 4, segments[3] == "reflection", method == "GET" { reflectionDetail(descriptor, id: id); return }
    }
    respondError(descriptor, status: 404, code: "not_found", message: "接口不存在。")
  }

  // MARK: - /v2 登记与周视图（§3.1–§3.5）

  private func registerPhoto(_ descriptor: Int32, jobId: String) {
    let result: (found: Bool, registeredAt: String) = lock.withLock {
      guard let index = jobs.firstIndex(where: { $0.id == jobId }) else { return (false, "") }
      if let existing = jobs[index].registeredAt { return (true, existing) }
      let stamp = "2026-09-30T08:15:00.123Z"
      jobs[index].registeredAt = stamp
      // 懒桥接的合成等价物：登记即备好这张照片的 3 道题（终态后才出现在周视图）。
      let jobIndex = index + 1
      let seeds = [
        ("M-\(jobIndex)1", "数学", ["一元一次方程"], "已知 x+y=1，求 x 的值。"),
        ("M-\(jobIndex)2", "数学", ["分式"], "化简分式 (x²−1)/(x−1)。"),
        ("M-\(jobIndex)3", "数学", ["一元一次方程"], "解方程：3x − 6 = 0。"),
      ]
      for (offset, seed) in seeds.enumerated() {
        items.append(ItemState(
          id: String(format: "itm_%012x%02x%02x", jobIndex, 0, offset),
          shortId: seed.0, subject: seed.1, knowledgeTags: seed.2, questionText: seed.3,
          jobId: jobId))
      }
      return (true, stamp)
    }
    guard result.found else {
      respondError(descriptor, status: 404, code: "not_found", message: "识别任务不存在。")
      return
    }
    respondJSON(descriptor, ["jobId": jobId, "registeredAt": result.registeredAt])
  }

  private func weekView(_ descriptor: Int32) {
    let json: [String: Any] = lock.withLock {
      let photos: [[String: Any]] = jobs.compactMap { job in
        guard let registeredAt = job.registeredAt else { return nil }
        let itemCount = items.filter { $0.jobId == job.id }.count
        return [
          "jobId": job.id,
          "registeredAt": registeredAt,
          "recognition": job.terminal ? "done" : "processing",
          "bridged": job.terminal,
          "bridgeError": NSNull(),
          "itemCount": job.terminal ? itemCount : 0,
        ]
      }
      let visible = items.filter { item in
        item.status != "archived_not_worth_review"
          && jobs.first(where: { $0.id == item.jobId })?.terminal == true
      }
      return ["week": "2026-W40", "photos": photos, "items": visible.map(cardJSON), "backlog": [[String: Any]]()]
    }
    respondJSON(descriptor, json)
  }

  private func cardJSON(_ item: ItemState) -> [String: Any] {
    [
      "id": item.id,
      "shortId": item.shortId,
      "subject": item.subject,
      "knowledgeTags": item.knowledgeTags,
      "questionExcerpt": item.questionText,
      "badge": item.badge,
      "status": item.status,
      "cropUrl": "/v2/items/\(item.id)/crop",
      "jobId": item.jobId,
    ]
  }

  private func setItemStatus(_ descriptor: Int32, id: String, status: String) {
    let result: String? = lock.withLock {
      guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
      items[index].status = status
      return status
    }
    guard let result else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    respondJSON(descriptor, ["id": id, "status": result])
  }

  // MARK: - /v2 推荐与练习（§3.8–§3.11）

  private func recommend(_ descriptor: Int32) {
    let json: [String: Any] = lock.withLock {
      let openPacketItemIds = Set(packets.filter { $0.returned.count < $0.itemIds.count }.flatMap(\.itemIds))
      let candidates = items.filter {
        ["ready_for_reflection", "eligible_for_review", "needs_recheck"].contains($0.status)
          && !openPacketItemIds.contains($0.id)
      }
      let recommended: [[String: Any]] = candidates.map { item in
        var card = cardJSON(item)
        card["reason"] = "本周新错题"
        card["tier"] = 4
        card["reflected"] = item.reflected
        return card
      }
      var notes: [String] = []
      if recommended.count < 5, !recommended.isEmpty {
        notes.append("本周可安排题目仅 \(recommended.count) 道，不足 5 道，已全部纳入")
      }
      return [
        "recommended": recommended,
        "others": [[String: Any]](),
        "notes": notes,
        "limits": ["min": 5, "max": 8],
      ]
    }
    respondJSON(descriptor, json)
  }

  private func createPractice(_ descriptor: Int32, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let itemIds = json["itemIds"] as? [String], !itemIds.isEmpty else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "itemIds 必须是非空的题目 ID 数组。")
      return
    }
    let slot = (json["practiceSlot"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let detail: [String: Any]? = lock.withLock {
      let packet = PacketState(
        id: String(format: "pkt_%016x", packets.count + 1),
        itemIds: itemIds,
        practiceSlot: slot ?? practiceSlotSetting,
        createdAt: "2026-09-30T08:20:00.000Z")
      packets.append(packet)
      for id in itemIds {
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].status = "scheduled" }
      }
      return packetDetailJSON(packet)
    }
    guard let detail else { return }
    respondJSON(descriptor, detail)
  }

  private func practiceList(_ descriptor: Int32) {
    let json: [String: Any] = lock.withLock {
      ["packets": packets.reversed().map { packet in
        [
          "id": packet.id,
          "week": "2026-W40",
          "status": packet.generatedAt == nil ? "scheduled" : "packet_generated",
          "practiceSlot": packet.practiceSlot,
          "createdAt": packet.createdAt,
          "generatedAt": packet.generatedAt ?? NSNull(),
          "itemCount": packet.itemIds.count,
        ] as [String: Any]
      }]
    }
    respondJSON(descriptor, json)
  }

  private func practiceDetail(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let packet = packets.first(where: { $0.id == id }) else { return nil }
      return packetDetailJSON(packet)
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "练习不存在。")
      return
    }
    respondJSON(descriptor, json)
  }

  /// 调用方须已持有锁。
  private func packetDetailJSON(_ packet: PacketState) -> [String: Any] {
    let practiceItems: [[String: Any]] = packet.itemIds.enumerated().compactMap { position, id in
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      var card = cardJSON(item)
      card["status"] = item.status
      card["reason"] = "本周新错题"
      card["tier"] = 4
      card["reflected"] = item.reflected
      card["position"] = position
      return card
    }
    return [
      "id": packet.id,
      "week": "2026-W40",
      "status": packet.generatedAt == nil ? "scheduled" : "packet_generated",
      "practiceSlot": packet.practiceSlot,
      "createdAt": packet.createdAt,
      "generatedAt": packet.generatedAt ?? NSNull(),
      "items": practiceItems,
    ]
  }

  // MARK: - /v2 打印（§3.12–§3.14）：轮询两次后就绪

  private func requestPrint(_ descriptor: Int32, id: String) {
    let found: Bool = lock.withLock {
      guard let index = packets.firstIndex(where: { $0.id == id }) else { return false }
      if packets[index].generatedAt != nil { return true }
      packets[index].printPolls = 0
      return true
    }
    guard found else {
      respondError(descriptor, status: 404, code: "not_found", message: "练习不存在。")
      return
    }
    let ready = lock.withLock { packets.first { $0.id == id }?.generatedAt != nil }
    if ready { printStatus(descriptor, id: id) } else {
      respond(descriptor, data: Data(#"{"status":"preparing"}"#.utf8), status: 202)
    }
  }

  private func printStatus(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let index = packets.firstIndex(where: { $0.id == id }) else { return nil }
      if packets[index].generatedAt != nil {
        return ["status": "ready", "snapshot": snapshotJSON(packets[index])]
      }
      packets[index].printPolls += 1
      let polls = packets[index].printPolls
      if polls >= 2 {
        packets[index].generatedAt = "2026-09-30T08:21:00.000Z"
        return ["status": "ready", "snapshot": snapshotJSON(packets[index])]
      }
      return ["status": "preparing", "progress": ["done": polls, "total": packets[index].itemIds.count]]
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "练习不存在。")
      return
    }
    respondJSON(descriptor, json)
  }

  /// 调用方须已持有锁。
  private func snapshotJSON(_ packet: PacketState) -> [String: Any] {
    let packetItems = packet.itemIds.enumerated().compactMap { position, id -> [String: Any]? in
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      return [
        "itemId": item.id,
        "shortId": item.shortId,
        "position": position,
        "subject": item.subject,
        "knowledgeTags": item.knowledgeTags,
        "mode": "text",
        "stemText": item.questionText,
        "cropMedia": NSNull(),
        "diagramMedia": [String](),
        "keyStepPrompt": "这题的关键一步是：",
        "checkboxes": ["独立做出", "看了一级提示", "看了二级提示", "没做出来"],
        "needsGlance": false,
        "glanceReason": NSNull(),
      ]
    }
    let coverItems = packet.itemIds.compactMap { id -> [String: Any]? in
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      return ["shortId": item.shortId, "sourceLabel": "原题"]
    }
    let answers = packet.itemIds.compactMap { id -> [String: Any]? in
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      return [
        "shortId": item.shortId,
        "hint1": "一级提示：先移项",
        "hint2": "二级提示：两边同时减 y",
        "answer": ["text": "x = 1 - y", "source": "ai", "label": "AI 参考，未经老师核验"],
        "fallbackNote": "对照原卷第 \(item.shortId.dropFirst(2)) 题（原卷不在手边就回家再对）",
      ]
    }
    return [
      "packetId": packet.id,
      "week": "2026-W40",
      "preparedAt": packet.generatedAt ?? "2026-09-30T08:21:00.000Z",
      "cover": [
        "title": "本周练习",
        "practiceSlot": packet.practiceSlot,
        "rules": ["不看答案，独立做", "卡住先看一级提示，再看二级", "做完打勾，写上做题日期"],
        "itemList": coverItems,
      ],
      "items": packetItems,
      "answerSheet": answers,
    ]
  }

  // MARK: - /v2 回传与回报（§3.15–§3.16）

  private func returnResults(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let results = json["results"] as? [[String: Any]], !results.isEmpty else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "results 必须是 1–8 条的数组。")
      return
    }
    let response: [[String: Any]]? = lock.withLock {
      guard let packetIndex = packets.firstIndex(where: { $0.id == id }) else { return nil }
      return results.map { entry in
        let itemId = entry["itemId"] as? String ?? ""
        let completion = entry["completion"] as? String ?? ""
        let correct = entry["correct"] as? Bool
        guard packets[packetIndex].itemIds.contains(itemId),
          let itemIndex = items.firstIndex(where: { $0.id == itemId }) else {
          return ["itemId": itemId, "ok": false, "error": "该题不在此复习包中"]
        }
        if packets[packetIndex].generatedAt == nil {
          return ["itemId": itemId, "ok": false, "error": "复习包尚未生成 PDF，不能回传"]
        }
        if packets[packetIndex].returned[itemId] != nil {
          return ["itemId": itemId, "ok": false, "error": "该题在此复习包中已回传，确认轮请等下个复习包"]
        }
        let record: ReturnRecord
        switch (completion, correct) {
        case ("independent", true):
          record = ReturnRecord(completion: completion, correct: correct, toStatus: "attempted",
            reason: "记下：当天独立做对，隔几天再独立做对才算掌握")
        case ("independent", false):
          record = ReturnRecord(completion: completion, correct: correct, toStatus: "needs_recheck",
            reason: "记下：做错了，还要再练")
        case ("hint1", _), ("hint2", _):
          record = ReturnRecord(completion: completion, correct: correct, toStatus: "needs_recheck",
            reason: "记下：看了提示，还要再练")
        case ("not_solved", _):
          record = ReturnRecord(completion: completion, correct: correct, toStatus: "needs_recheck",
            reason: "记下：没做出来，还要再练")
        default:
          record = ReturnRecord(completion: completion, correct: correct, toStatus: "needs_recheck",
            reason: "记下：没做，还要再练")
        }
        packets[packetIndex].returned[itemId] = record
        items[itemIndex].status = record.toStatus
        return ["itemId": itemId, "ok": true, "toStatus": record.toStatus, "reason": record.reason]
      }
    }
    guard let response else {
      respondError(descriptor, status: 404, code: "not_found", message: "练习不存在。")
      return
    }
    respondJSON(descriptor, ["results": response])
  }

  private func practiceSummary(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let packet = packets.first(where: { $0.id == id }) else { return nil }
      let returned = packet.returned
      let independentCorrect = returned.values.filter { $0.completion == "independent" && $0.correct == true }.count
      let againItems: [[String: Any]] = packet.itemIds.compactMap { itemId in
        guard let record = returned[itemId], record.toStatus == "needs_recheck",
          let item = items.first(where: { $0.id == itemId }) else { return nil }
        var card = cardJSON(item)
        card["reason"] = againReason(record)
        return card
      }
      let pendingItems: [[String: Any]] = packet.itemIds.compactMap { itemId in
        guard let record = returned[itemId], record.toStatus == "attempted",
          let item = items.first(where: { $0.id == itemId }) else { return nil }
        var card = cardJSON(item)
        card["reason"] = "当天做对，隔几天再独立做对才算掌握"
        return card
      }
      return [
        "answered": returned.count,
        "total": packet.itemIds.count,
        "independentCorrect": independentCorrect,
        "masteredNow": [[String: Any]](),
        "again": againItems,
        "pending": pendingItems,
        "calibration": ["confidentTotal": 0, "missedCount": 0, "text": NSNull(), "items": [[String: Any]]()],
        "nextConfirmOn": NSNull(),
      ]
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "练习不存在。")
      return
    }
    respondJSON(descriptor, json)
  }

  private func againReason(_ record: ReturnRecord) -> String {
    switch record.completion {
    case "not_solved": "没做出来"
    case "not_done": "没做"
    case "hint1", "hint2": "看了提示"
    default: "做错"
    }
  }

  // MARK: - /v2 追问与复盘（§3.17–§3.20）：固定合成内容

  private func askReflection(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
      let question = items[index].pendingQuestion ?? "合成追问：这一步当时是怎么想的？"
      items[index].pendingQuestion = question
      return ["turn": 1, "question": question, "source": "ai"]
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    respondJSON(descriptor, json)
  }

  private func answerReflection(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let answer = json["answer"] as? String, (1...300).contains(answer.count) else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "回答需要 1–300 字。")
      return
    }
    let result: [String: Any]? = lock.withLock {
      guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
      guard items[index].pendingQuestion != nil else { return ["__conflict__": true] }
      items[index].pendingQuestion = nil
      let suggestion = (summary: "合成归纳：把移项当成了照抄，漏了变号", cause: "推理步骤", attemptState: "方法基本正确但步骤出错")
      items[index].suggestion = suggestion
      return [
        "turn": 1,
        "summary": suggestion.summary,
        "suggestedCause": suggestion.cause,
        "suggestedAttemptState": suggestion.attemptState,
        "secondQuestion": NSNull(),
      ]
    }
    guard let result else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    if result["__conflict__"] != nil {
      respondError(descriptor, status: 409, code: "conflict", message: "当前没有待回答的追问。")
      return
    }
    respondJSON(descriptor, result)
  }

  private func submitReflection(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let attemptState = json["attemptState"] as? String, let cause = json["cause"] as? String,
      let mastery = json["masteryFeeling"] as? Int else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "请求正文不合法。")
      return
    }
    let record: [String: Any]? = lock.withLock {
      guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
      items[index].reflected = true
      if items[index].status == "ready_for_reflection" { items[index].status = "eligible_for_review" }
      let suggestion = items[index].suggestion
      let entry: [String: Any] = [
        "id": String(format: "dia_%016x", index + 1),
        "attemptState": attemptState,
        "cause": cause,
        "masteryFeeling": mastery,
        "summary": (json["summary"] as? String) ?? suggestion?.summary ?? NSNull(),
        "adoptedAi": suggestion.map { $0.cause == cause && $0.attemptState == attemptState } ?? false,
        "source": "v2",
        "createdAt": "2026-09-30T08:25:00.000Z",
        "status": items[index].status,
      ]
      items[index].reflection = entry
      return entry
    }
    guard let record else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    respondJSON(descriptor, record)
  }

  private func reflectionDetail(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      var suggestion: [String: Any]?
      if let value = item.suggestion {
        suggestion = ["summary": value.summary, "suggestedCause": value.cause, "suggestedAttemptState": value.attemptState]
      }
      return [
        "turns": [[String: Any]](),
        "suggestion": suggestion ?? NSNull(),
        "reflection": item.reflection ?? NSNull(),
      ]
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    respondJSON(descriptor, json)
  }

  // MARK: - /v2 识别结果与修改（§3.21–§3.24）

  private func evidence(_ descriptor: Int32, id: String) {
    let json: [String: Any]? = lock.withLock {
      guard let item = items.first(where: { $0.id == id }) else { return nil }
      return evidenceJSON(item)
    }
    guard let json else {
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
      return
    }
    respondJSON(descriptor, json)
  }

  private func evidenceJSON(_ item: ItemState) -> [String: Any] {
    [
      "questionText": item.questionText,
      "subject": item.subject,
      "knowledgeTags": item.knowledgeTags,
      "observations": [["id": "o1", "kind": "student_work", "text": "x = 1"]],
      "badge": item.badge,
      "revision": item.revision,
    ]
  }

  private func proposeCorrection(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let revision = json["revision"] as? Int else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "请求正文不合法。")
      return
    }
    enum Outcome { case missing, conflict(Int), created([String: Any]) }
    let outcome: Outcome = lock.withLock {
      guard let index = items.firstIndex(where: { $0.id == id }) else { return .missing }
      let item = items[index]
      guard item.revision == revision else { return .conflict(item.revision) }
      // 固定合成建议：题干里「求 x 的值」改成「求 y 的值」（不含则尾部补充）。
      let before = item.questionText
      let after: String
      let change: [String: Any]
      if before.contains("求 x 的值") {
        after = before.replacingOccurrences(of: "求 x 的值", with: "求 y 的值")
        change = ["field": "questionText", "before": before, "after": after,
          "find": "求 x 的值", "replace": "求 y 的值"]
      } else {
        after = before + "（已按你的说明修改）"
        change = ["field": "questionText", "before": before, "after": after,
          "find": NSNull(), "replace": NSNull()]
      }
      proposalCounter += 1
      let proposal = ProposalState(id: String(format: "crp_%016x", proposalCounter),
        itemId: id, revision: revision, changes: [change])
      proposals.append(proposal)
      return .created(["proposalId": proposal.id, "revision": revision, "changes": [change], "clarify": NSNull()])
    }
    switch outcome {
    case .missing:
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
    case .conflict(let current):
      respondError(descriptor, status: 409, code: "conflict", message: "识别结果已更新，请重新加载。", revision: current)
    case .created(let json):
      respondJSON(descriptor, json)
    }
  }

  private func acceptCorrection(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let proposalId = json["proposalId"] as? String, let revision = json["revision"] as? Int else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "请求正文不合法。")
      return
    }
    enum Outcome { case missing, conflict(Int), applied([String: Any]) }
    let outcome: Outcome = lock.withLock {
      guard let itemIndex = items.firstIndex(where: { $0.id == id }) else { return .missing }
      guard let proposalIndex = proposals.firstIndex(where: { $0.id == proposalId && $0.itemId == id }) else { return .missing }
      let item = items[itemIndex]
      guard item.revision == revision, proposals[proposalIndex].revision == revision else {
        return .conflict(item.revision)
      }
      let changes = proposals[proposalIndex].changes
      proposals.remove(at: proposalIndex)
      applyChanges(&items[itemIndex], changes: changes)
      return .applied(["revision": items[itemIndex].revision, "card": cardJSON(items[itemIndex])])
    }
    switch outcome {
    case .missing:
      respondError(descriptor, status: 404, code: "not_found", message: "修改建议不存在。")
    case .conflict(let current):
      respondError(descriptor, status: 409, code: "conflict", message: "识别结果已更新，该建议已失效。", revision: current)
    case .applied(let json):
      respondJSON(descriptor, json)
    }
  }

  private func directCorrection(_ descriptor: Int32, id: String, body: Data) {
    guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let revision = json["revision"] as? Int, let changes = json["changes"] as? [[String: Any]],
      !changes.isEmpty else {
      respondError(descriptor, status: 400, code: "invalid_request", message: "请求正文不合法。")
      return
    }
    enum Outcome { case missing, conflict(Int), invalid(String), applied([String: Any]) }
    let outcome: Outcome = lock.withLock {
      guard let itemIndex = items.firstIndex(where: { $0.id == id }) else { return .missing }
      let item = items[itemIndex]
      guard item.revision == revision else { return .conflict(item.revision) }
      for change in changes {
        let before = change["before"] as? String ?? ""
        switch change["field"] as? String ?? "" {
        case "questionText" where before != item.questionText:
          return .invalid("题干的改前内容与当前识别结果不一致，已略过该条修改")
        case "subject" where before != item.subject:
          return .invalid("学科的改前内容与当前识别结果不一致，已略过该条修改")
        case "knowledgeTags":
          let current = (try? JSONSerialization.data(withJSONObject: item.knowledgeTags))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
          if before != current { return .invalid("知识点的改前内容与当前识别结果不一致，已略过该条修改") }
        default: continue
        }
      }
      applyChanges(&items[itemIndex], changes: changes)
      return .applied(["revision": items[itemIndex].revision, "card": cardJSON(items[itemIndex])])
    }
    switch outcome {
    case .missing:
      respondError(descriptor, status: 404, code: "not_found", message: "题目不存在或不属于手机上传。")
    case .conflict(let current):
      respondError(descriptor, status: 409, code: "conflict", message: "识别结果已更新，请重新加载。", revision: current)
    case .invalid(let message):
      respondError(descriptor, status: 400, code: "invalid_request", message: message)
    case .applied(let json):
      respondJSON(descriptor, json)
    }
  }

  /// 调用方须已持有锁。生效规则同 §3.23：revision +1；含 questionText 时徽标置 ok；不改题目状态。
  private func applyChanges(_ item: inout ItemState, changes: [[String: Any]]) {
    var touchedQuestionText = false
    for change in changes {
      let after = change["after"] as? String ?? ""
      switch change["field"] as? String ?? "" {
      case "questionText":
        item.questionText = after
        touchedQuestionText = true
      case "subject":
        item.subject = after
      case "knowledgeTags":
        if let data = after.data(using: .utf8),
          let tags = try? JSONSerialization.jsonObject(with: data) as? [String] {
          item.knowledgeTags = tags
        }
      default: continue
      }
    }
    item.revision += 1
    if touchedQuestionText { item.badge = "ok" }
  }

  // MARK: - 响应工具

  private func respondJSON(_ descriptor: Int32, _ json: [String: Any], status: Int = 200) {
    guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
    respond(descriptor, data: data, status: status)
  }

  private func respondError(_ descriptor: Int32, status: Int, code: String, message: String, revision: Int? = nil) {
    var json: [String: Any] = ["error": ["code": code, "message": message]]
    if let revision { json["revision"] = revision }
    respondJSON(descriptor, json, status: status)
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
}
