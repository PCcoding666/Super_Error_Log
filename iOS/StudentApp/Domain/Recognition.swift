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

  var coreValue: RecognitionQuestion {
    var copy = self; copy.candidateBox = nil; copy.error?.recoverable = nil; return copy
  }
  func sameContent(as old: RecognitionQuestion) -> Bool {
    coreValue == old.coreValue && (old.candidateBox == nil || candidateBox == old.candidateBox)
  }

  var active: Bool { status == "queued" || status == "processing" }
  var marked: Bool { selectionEvidence == "marked_wrong" || selectionEvidence == "corrected" }
  var canAccept: Bool {
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
}

struct PairingConfiguration: Codable, Equatable, Sendable {
  let baseURL: URL
  let token: String
  init(baseURL: String, token: String) throws {
    guard let parts = URLComponents(string: baseURL), parts.scheme == "http",
      ["127.0.0.1", "localhost", "[::1]", "::1"].contains(parts.host ?? ""),
      let port = parts.port, (1...65535).contains(port), parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path),
      let url = parts.url, token.count >= 16, !token.contains("\n"), !token.contains("\r")
    else { throw RecognitionClientError.invalidPairing }
    self.baseURL = url
    self.token = token
  }
}

enum RecognitionClientError: Error, LocalizedError {
  case invalidPairing, invalidResponse, service(String), missingMedia
  var errorDescription: String? {
    switch self {
    case .invalidPairing: "请输入本机回环地址（如 http://127.0.0.1:3101）和至少 16 位配对口令。"
    case .invalidResponse: "本机服务返回的内容无法安全使用，请检查连接后重试。"
    case .service(let message): message
    case .missingMedia: "题目需要的安全图示尚未完整保存在本机，暂时不能生成练习包。"
    }
  }
}
