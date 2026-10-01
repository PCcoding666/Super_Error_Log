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
}
