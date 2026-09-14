import Foundation

struct StudyProblem: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let source: String
  let number: String
  let title: String
  let topic: String
  let stem: String
  let sourceNote: String
  let symbol: String
  let isExample: Bool
  let sourceImagePath: String?
  let diagramPaths: [String]
  let observations: [SourceObservation]
  let confirmationRevision: Int?
  let printable: Bool

  var displaySourceNote: String {
    guard isExample else { return sourceNote }
    switch sourceNote {
    case "Your original working shows √16; a later correction shows √13. What would help you catch a slip like this?":
      return "原作记录为 √16，之后的订正为 √13。下次怎样帮助自己发现这类差异？"
    case "Several lines of working overlap. Use the original photo to revisit your thinking; the prototype does not guess the crossed-out steps.":
      return "多行解题过程有重叠。请对照原图回想思路；应用不会猜测被划掉的步骤。"
    case "Look back at your original working. Decide for yourself which part is worth trying again.":
      return "回看自己的原作过程，由你决定哪一部分值得再试一次。"
    default: return sourceNote
    }
  }

  init(example: SampleProblem) {
    id = example.id; source = example.source; number = example.number
    title = example.title; topic = example.topic; stem = example.stem
    sourceNote = example.sourceNote; symbol = example.symbol; isExample = true
    sourceImagePath = nil; diagramPaths = []; observations = []; confirmationRevision = nil
    printable = true
  }

  init(job: RecognitionJob, question: RecognitionQuestion, photoName: String) throws {
    guard question.status == "confirmed", question.confirmedAt != nil, question.canAccept,
      let evidence = question.evidence, StudyPersistence.isSafePhotoName(photoName)
    else { throw StudyError.selectionNotReady }
    id = job.id + "/" + question.id; source = job.photoName; number = question.number
    title = "第 \(question.number) 题"; topic = evidence.knowledgeTags.joined(separator: " · ")
    stem = evidence.questionText; sourceNote = "对照原图回想自己的解题过程。"
    symbol = "doc.text.magnifyingglass"; isExample = false
    sourceImagePath = "Photos/" + String(photoName.dropLast(4)) + ".source"
    diagramPaths = question.diagramMediaIds.map { "Media/\(job.id)/\($0).jpg" }
    observations = evidence.observations; confirmationRevision = question.revision; printable = true
  }

  var hasValidSnapshot: Bool {
    guard printable, !stem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    if isExample { return SampleProblem.find(id) != nil && sourceImagePath == nil && diagramPaths.isEmpty }
    let ids = id.split(separator: "/", omittingEmptySubsequences: false)
    guard ids.count == 2, ids.allSatisfy({ UUID(uuidString: String($0)) != nil }),
      let confirmationRevision, confirmationRevision > 0,
      let sourceImagePath, sourceImagePath.hasPrefix("Photos/"), sourceImagePath.hasSuffix(".source"),
      UUID(uuidString: String(sourceImagePath.dropFirst(7).dropLast(7))) != nil else { return false }
    return Set(diagramPaths).count == diagramPaths.count && diagramPaths.allSatisfy { path in
      let parts = path.split(separator: "/", omittingEmptySubsequences: false)
      return parts.count == 3 && parts[0] == "Media" && parts[1] == ids[0]
        && StudyPersistence.isSafePhotoName(String(parts[2]))
    }
  }

  func printableDiagramURLs(in directory: URL) throws -> [URL] {
    guard hasValidSnapshot else { throw StudyError.selectionNotReady }
    return try diagramPaths.map { path in
      let url = directory.appendingPathComponent(path)
      let root = directory.resolvingSymlinksInPath().standardizedFileURL.path + "/"
      guard url.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(root),
        FileManager.default.fileExists(atPath: url.path) else { throw RecognitionClientError.missingMedia }
      return url
    }
  }
}
