import Foundation

enum StudyError: Error, Equatable, LocalizedError {
  case incompleteReflection, unknownProblem, selectionNotReady, emptySelection, unsupportedState

  var errorDescription: String? {
    switch self {
    case .incompleteReflection: "请回答每一个问题，再保存复盘。"
    case .unknownProblem:
      "当前版本无法使用这道题。你已保存的数据没有被修改。"
    case .selectionNotReady: "请先完成复盘，再把这道题加入练习包。"
    case .emptySelection: "请至少选择一道题加入练习包。"
    case .unsupportedState:
      "无法安全打开这份已保存的内容。你的原有数据仍然保留。"
    }
  }
}

struct ReflectionDraft: Codable, Equatable {
  var attempt: String?
  var takeaway: String?
  var confidence: String?
  var revisit: Bool?
  var note = ""
  var submittedAt: Date?
}

struct PaperPack: Codable, Identifiable, Equatable {
  var id = UUID()
  var createdAt: Date
  var problemIDs: [String]
  var outcomes: [String: String] = [:]
  let problemSnapshots: [StudyProblem]

  init(createdAt: Date, problemIDs: [String], problemSnapshots: [StudyProblem]) {
    self.createdAt = createdAt; self.problemIDs = problemIDs; self.problemSnapshots = problemSnapshots
  }

  private enum CodingKeys: String, CodingKey { case id, createdAt, problemIDs, outcomes, problemSnapshots }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(UUID.self, forKey: .id)
    createdAt = try values.decode(Date.self, forKey: .createdAt)
    problemIDs = try values.decode([String].self, forKey: .problemIDs)
    outcomes = try values.decodeIfPresent([String: String].self, forKey: .outcomes) ?? [:]
    if let snapshots = try values.decodeIfPresent([StudyProblem].self, forKey: .problemSnapshots) {
      problemSnapshots = snapshots
    } else {
      problemSnapshots = try problemIDs.map { id in
        guard let example = SampleProblem.find(id) else { throw StudyError.unsupportedState }
        return StudyProblem(example: example)
      }
    }
    guard problemSnapshots.map(\.id) == problemIDs else { throw StudyError.unsupportedState }
  }
}

struct StudyState: Codable, Equatable {
  var schemaVersion = 2
  var drafts: [String: ReflectionDraft] = [:]
  var selectedIDs: Set<String> = []
  var packs: [PaperPack] = []
  var importedPhotos: [String] = []
  var recognitionTasks: [LocalRecognitionTask] = []
  var realProblems: [StudyProblem] = []
  /// T6c：上传同意只问一次（旧存档解码为 false）。同意后新加的照片自动上传，不再弹。
  var uploadConsentGranted = false
  var allProblems: [StudyProblem] { realProblems + SampleProblem.all.map { StudyProblem(example: $0) } }
  func problem(_ id: String) -> StudyProblem? { allProblems.first { $0.id == id && $0.printable } }

  init() {}
  private enum CodingKeys: String, CodingKey {
    case schemaVersion, drafts, selectedIDs, packs, importedPhotos, recognitionTasks, realProblems, uploadConsentGranted
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let version = try values.decode(Int.self, forKey: .schemaVersion)
    guard [1, 2].contains(version) else { throw StudyError.unsupportedState }
    drafts = try values.decode([String: ReflectionDraft].self, forKey: .drafts)
    selectedIDs = try values.decode(Set<String>.self, forKey: .selectedIDs)
    packs = try values.decode([PaperPack].self, forKey: .packs)
    importedPhotos = try values.decode([String].self, forKey: .importedPhotos)
    recognitionTasks = try values.decodeIfPresent([LocalRecognitionTask].self, forKey: .recognitionTasks) ?? []
    realProblems = try values.decodeIfPresent([StudyProblem].self, forKey: .realProblems) ?? []
    // 旧存档无该键：解码为未同意，不拒绝加载。
    uploadConsentGranted = try values.decodeIfPresent(Bool.self, forKey: .uploadConsentGranted) ?? false
  }

  mutating func ingest(_ job: RecognitionJob, photoName: String) throws {
    guard job.version == 1, UUID(uuidString: job.id) != nil,
      UUID(uuidString: job.sourceMediaId) != nil, job.questions.allSatisfy({ UUID(uuidString: $0.id) != nil }),
      StudyPersistence.isSafePhotoName(photoName) else { throw StudyError.unsupportedState }
    let index = recognitionTasks.firstIndex { $0.job?.id == job.id }
      ?? recognitionTasks.firstIndex { $0.photoName == photoName }
    let sourcePhotoName = index.map { recognitionTasks[$0].photoName } ?? photoName
    if let previous = index.flatMap({ recognitionTasks[$0].job }) {
      guard previous.id == job.id else { throw StudyError.unsupportedState }
      guard job.revision >= previous.revision else { return }
      if job.revision == previous.revision && job.coreValue != previous.coreValue { return }
      guard previous.questions.allSatisfy({ old in
        job.questions.contains { $0.id == old.id && ($0.revision > old.revision || $0.sameContent(as: old)) }
      }) else { return }
    }
    if let index {
      recognitionTasks[index].job = job; recognitionTasks[index].lastError = nil
    } else {
      recognitionTasks.append(LocalRecognitionTask(id: UUID(), photoName: photoName,
        uploadName: photoName, job: job))
    }
    for question in job.questions {
      let id = job.id + "/" + question.id
      let snapshot = try? StudyProblem(job: job, question: question, photoName: sourcePhotoName)
      let previous = realProblems.first { $0.id == id }
      if previous != snapshot {
        selectedIDs.remove(id)
        if drafts[id] != nil { drafts[id]?.submittedAt = nil }
        realProblems.removeAll { $0.id == id }
        if let snapshot { realProblems.append(snapshot) }
      }
    }
  }
}

struct StudyPersistence {
  let directory: URL
  var stateURL: URL { directory.appendingPathComponent("study-state.json") }
  func load() throws -> StudyState {
    guard FileManager.default.fileExists(atPath: stateURL.path) else { return StudyState() }
    let state = try JSONDecoder().decode(StudyState.self, from: Data(contentsOf: stateURL))
    guard state.schemaVersion == 2,
      state.importedPhotos.allSatisfy({ Self.isSafePhotoName($0) }),
      state.recognitionTasks.allSatisfy({ Self.isSafePhotoName($0.photoName) && Self.isSafePhotoName($0.uploadName) }),
      state.realProblems.allSatisfy({ problem in
        !problem.isExample && problem.hasValidSnapshot && state.recognitionTasks.contains { task in
          guard let job = task.job, let question = job.questions.first(where: { job.id + "/" + $0.id == problem.id }) else { return false }
          return (try? StudyProblem(job: job, question: question, photoName: task.photoName)) == problem
        }
      }),
      state.drafts.keys.allSatisfy({ id in
        state.problem(id) != nil || state.recognitionTasks.contains { task in
          guard let job = task.job else { return false }
          return job.questions.contains { job.id + "/" + $0.id == id }
        }
      }),
      state.packs.allSatisfy({ $0.problemSnapshots.allSatisfy(\.hasValidSnapshot) })
    else { throw StudyError.unsupportedState }
    return state
  }

  func save(_ state: StudyState) throws {
    try prepareDirectory()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(state).write(to: stateURL, options: .atomic)
    // Atomic replacement creates a new file, so reapply the explicit exclusion.
    try Self.excludeFromBackup(stateURL)
  }

  func prepareDirectory() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Self.excludeFromBackup(directory)
  }

  static func excludeFromBackup(_ location: URL) throws {
    var location = location
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try location.setResourceValues(values)
  }

  static func isSafePhotoName(_ name: String) -> Bool {
    guard name.hasSuffix(".jpg") else { return false }
    return UUID(uuidString: String(name.dropLast(4))) != nil
  }
}
