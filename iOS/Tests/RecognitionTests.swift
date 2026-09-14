import XCTest
import Foundation
@testable import StudentCore

// Synthetic API documents; these tests never contact the service or a model.
final class RecognitionTests: XCTestCase {
  static let jobID = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let questionID = "a42b4eb2-12ff-499f-92de-e49d7cb36ef7"
  static let fixture = #"{"version":1,"id":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","revision":8,"photoName":"Synthetic.jpg","sourceHash":"abc","sourceMediaId":"6ddc034b-b0f8-4288-b9c1-4f496cfb90df","status":"completed","phase":"complete","inventoryWarnings":[],"questions":[{"id":"a42b4eb2-12ff-499f-92de-e49d7cb36ef7","number":"4","revision":3,"status":"confirmed","selectionEvidence":"marked_wrong","evidence":{"version":1,"questionNumber":"4","questionText":"求 x 的值。","subject":"数学","chapter":"","knowledgeTags":["方程"],"questionType":"计算","questionRegion":{"x":0.08,"y":0.2,"width":0.84,"height":0.3},"requiresDiagram":false,"regions":[],"observations":[],"uncertainties":[]},"verification":{"textComplete":true,"questionCropComplete":true,"questionCropPure":true,"transcriptionMatches":true,"diagramSafe":true,"issues":[]},"questionMediaId":"1800c1bc-47ab-42bc-a46d-315005bdc695","diagramMediaIds":[],"error":null,"confirmedAt":"2026-09-14T10:01:30.000Z"}],"error":null,"createdAt":"2026-09-14T10:00:00.000Z","updatedAt":"2026-09-14T10:01:30.000Z"}"#

  static func job(_ replacing: [String: String] = [:]) throws -> RecognitionJob {
    var json = fixture
    for (old, new) in replacing { json = json.replacingOccurrences(of: old, with: new) }
    return try RecognitionCodec.decoder().decode(RecognitionJob.self, from: Data(json.utf8))
  }

  func testFractionalAndWholeSecondDatesDecode() throws {
    let first = try Self.job()
    let second = try Self.job(["30.000Z": "30Z", "00.000Z": "00Z"])
    XCTAssertEqual(first.updatedAt, second.updatedAt)
  }

  func testChineseSampleGuidanceDoesNotRewriteStoredSourceOrRealEvidence() throws {
    let displayed = SampleProblem.all.map { StudyProblem(example: $0).displaySourceNote }
    XCTAssertEqual(displayed, ["原作记录为 √16，之后的订正为 √13。下次怎样帮助自己发现这类差异？", "多行解题过程有重叠。请对照原图回想思路；应用不会猜测被划掉的步骤。", "回看自己的原作过程，由你决定哪一部分值得再试一次。"])
    XCTAssertTrue(SampleProblem.all[0].sourceNote.contains("Your original working"))
    let accepted = try StudyProblem(job: Self.job(), question: Self.job().questions[0], photoName: UUID().uuidString + ".jpg")
    XCTAssertEqual(accepted.displaySourceNote, accepted.sourceNote)
  }

  func testAdditiveRecoveryAndCandidatePositionDecodeWithoutRewritingOldDocuments() throws {
    let old = try Self.job()
    XCTAssertNil(old.questions[0].candidateBox)
    let updated = try Self.job(["\"selectionEvidence\":\"marked_wrong\"": #""candidateBox":{"x":0.6,"y":0.1,"width":0.3,"height":0.4},"selectionEvidence":"marked_wrong""#])
    XCTAssertEqual(updated.questions[0].candidateBox?.x, 0.6)
    let failure = try RecognitionCodec.decoder().decode(RecognitionFailure.self, from: Data(#"{"code":"invalid_output","message":"合成失败","stage":"verify","retryable":false,"recoverable":true}"#.utf8))
    XCTAssertFalse(failure.retryable); XCTAssertTrue(failure.canRecover)
    let legacy = try RecognitionCodec.decoder().decode(RecognitionFailure.self, from: Data(#"{"code":"invalid_output","message":"合成失败","stage":"verify","retryable":false}"#.utf8))
    XCTAssertFalse(legacy.canRecover, "Old client records need explicit server policy refresh, never optimistic recovery")
    var state = StudyState(); let photo = UUID().uuidString + ".jpg"
    try state.ingest(old, photoName: photo); try state.ingest(updated, photoName: photo)
    XCTAssertEqual(state.recognitionTasks[0].job?.questions[0].candidateBox?.x, 0.6)
    XCTAssertEqual(state.realProblems[0].stem, "求 x 的值。")
  }

  func testVerifiedDiagramUsesIndependentVerificationAndAllocatedMedia() throws {
    let substitutions = ["\"requiresDiagram\":false": "\"requiresDiagram\":true",
      "\"regions\":[]": #""regions":[{"id":"d1","kind":"diagram","box":{"x":0.1,"y":0.1,"width":0.2,"height":0.2},"confidence":0.8,"cleanForPrint":false}]"#,
      "\"diagramMediaIds\":[]": #""diagramMediaIds":["2ddc034b-b0f8-4288-b9c1-4f496cfb90df"]"#]
    XCTAssertTrue(try Self.job(substitutions).questions[0].canAccept,
      "API deliberately leaves model cleanForPrint false; independent verification and real media govern acceptance")
    var missing = substitutions
    missing.removeValue(forKey: "\"diagramMediaIds\":[]")
    XCTAssertFalse(try Self.job(missing).questions[0].canAccept)
  }

  func testUncheckedOrUnknownQuestionCannotEnterReflection() throws {
    for status in ["ready", "needs_check", "failed", "unknown"] {
      var state = StudyState()
      try state.ingest(try Self.job(["\"status\":\"confirmed\"": "\"status\":\"\(status)\""]), photoName: UUID().uuidString + ".jpg")
      XCTAssertTrue(state.realProblems.isEmpty)
      XCTAssertThrowsError(try state.select(Self.jobID + "/" + Self.questionID, selected: true))
    }
    let unchecked = try Self.job(["\"diagramSafe\":true": "\"diagramSafe\":false"])
    XCTAssertFalse(unchecked.questions[0].canAccept)
  }

  func testIngestionRejectsStaleSnapshotAndCreatesImmutablePack() throws {
    var state = StudyState()
    let photo = UUID().uuidString + ".jpg"
    try state.ingest(try Self.job(), photoName: photo)
    try state.ingest(try Self.job(), photoName: photo)
    XCTAssertEqual(state.realProblems.count, 1)
    let id = Self.jobID + "/" + Self.questionID
    try state.submit(id, draft: ReflectionDraft(attempt: "I had a plan", takeaway: "Check each calculation", confidence: "With a hint", revisit: true))
    try state.select(id, selected: true)
    let pack = try state.makePack()
    XCTAssertEqual(pack.problemSnapshots.first?.stem, "求 x 的值。")
    try state.ingest(try Self.job(["\"revision\":8": "\"revision\":7", "求 x 的值。": "STALE"]), photoName: photo)
    XCTAssertEqual(state.problem(id)?.stem, "求 x 的值。")
    try state.ingest(try Self.job(["\"revision\":8": "\"revision\":9", "\"revision\":3": "\"revision\":4", "求 x 的值。": "新题干"]), photoName: photo)
    XCTAssertEqual(state.packs.first?.problemSnapshots.first?.stem, "求 x 的值。")
    XCTAssertFalse(state.selectedIDs.contains(id), "Changed source revision requires reflection resubmission")
  }

  func testLegacyStateAndPacksMigrateWithoutRewritingStudentValues() throws {
    let json = #"{"schemaVersion":1,"drafts":{"5516-14":{"attempt":"I had a plan","note":"My original note"}},"selectedIDs":[],"packs":[{"id":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","createdAt":0,"problemIDs":["5516-14"],"outcomes":{}}],"importedPhotos":[]}"#
    let loaded = try JSONDecoder().decode(StudyState.self, from: Data(json.utf8))
    XCTAssertEqual(loaded.drafts["5516-14"]?.note, "My original note")
    XCTAssertEqual(loaded.drafts["5516-14"]?.attempt, "I had a plan")
    XCTAssertEqual(loaded.packs[0].problemSnapshots.count, 1)
    XCTAssertTrue(loaded.packs[0].problemSnapshots[0].isExample)
    XCTAssertEqual(loaded.schemaVersion, 2)
  }

  func testLoopbackPairingRejectsCredentialOrRemoteURLs() throws {
    for url in ["https://127.0.0.1:3101", "http://evil.test:3101", "http://user:pass@localhost:3101", "http://localhost:3101/?token=x", "http://localhost:3101/#x", "http://localhost:3101/path"] {
      XCTAssertThrowsError(try PairingConfiguration(baseURL: url, token: "synthetic-pairing-only"))
    }
    for url in ["http://127.0.0.1:3101", "http://localhost:3101", "http://[::1]:3101"] {
      XCTAssertNoThrow(try PairingConfiguration(baseURL: url, token: "synthetic-pairing-only"))
    }
  }

  func testPairingScopesIsolateValidQACollectionsFromNormalKeychain() {
    XCTAssertEqual(PairingScope.account(collectionName: "StudentExperience"), "loopback-pairing")
    XCTAssertEqual(PairingScope.account(collectionName: "UITest-3f7b69dc-9d37-4aaa-b965-bb61243445a0"), "loopback-pairing-qa-3F7B69DC-9D37-4AAA-B965-BB61243445A0")
    XCTAssertNil(PairingScope.account(collectionName: "UITest-invalid"))
  }

  func testPersistedRealStateRejectsEscapingMediaPathsAndForgedAcceptance() throws {
    var state = StudyState()
    try state.ingest(try Self.job(), photoName: UUID().uuidString + ".jpg")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let persistence = StudyPersistence(directory: directory)
    try persistence.save(state)
    var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: persistence.stateURL)) as? [String: Any])
    var problems = try XCTUnwrap(document["realProblems"] as? [[String: Any]])
    problems[0]["sourceImagePath"] = "../../outside.source"
    document["realProblems"] = problems
    let corrupted = try JSONSerialization.data(withJSONObject: document)
    try corrupted.write(to: persistence.stateURL)
    XCTAssertThrowsError(try persistence.load())
    XCTAssertEqual(try Data(contentsOf: persistence.stateURL), corrupted)
  }

  func testPrintedTextPaginationRetainsEveryLongStemCharacter() throws {
    let text = (1...160).map { "第\($0)小问：求 x² + y² 的值，保留条件 α ≥ 2。" }.joined(separator: "\n")
    let ranges = try PrintedTextLayout.ranges(for: text, width: 511, height: 550)
    XCTAssertGreaterThan(ranges.count, 2)
    XCTAssertEqual(ranges.map { (text as NSString).substring(with: $0) }.joined(), text)
    XCTAssertTrue(ranges.allSatisfy { $0.length > 0 })
  }

  func testPrintableInputRejectsMissingRequiredDiagramBeforeWritingPDF() throws {
    let substitutions = ["\"requiresDiagram\":false": "\"requiresDiagram\":true",
      "\"regions\":[]": #""regions":[{"id":"d1","kind":"diagram","box":{"x":0.1,"y":0.1,"width":0.2,"height":0.2},"confidence":0.8,"cleanForPrint":false}]"#,
      "\"diagramMediaIds\":[]": #""diagramMediaIds":["2ddc034b-b0f8-4288-b9c1-4f496cfb90df"]"#]
    let problem = try StudyProblem(job: Self.job(substitutions), question: Self.job(substitutions).questions[0], photoName: UUID().uuidString + ".jpg")
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    XCTAssertThrowsError(try problem.printableDiagramURLs(in: root))
    let url = root.appendingPathComponent(problem.diagramPaths[0])
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data([0xff, 0xd8, 0xff]).write(to: url)
    XCTAssertEqual(try problem.printableDiagramURLs(in: root), [url])
  }

  func testSyntheticHTTPUploadReusesSavedBytesAndKeyAndDecodesEnvelope() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRecognitionProtocol.self]
    let client = RecognitionClient(configuration: try PairingConfiguration(baseURL: "http://localhost:3101", token: "synthetic-pairing-only"), sessionConfiguration: configuration)
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("immutable.jpg")
    let bytes = Data([0xff, 0xd8, 0xff, 0x00, 0xd9])
    try bytes.write(to: url)
    let key = UUID()
    let first = try await client.upload(file: url, idempotencyKey: key, photoName: "中文.jpg")
    let second = try await client.upload(file: url, idempotencyKey: key, photoName: "中文.jpg")
    XCTAssertEqual(first.id, Self.jobID)
    XCTAssertEqual(second.questions.first?.evidence?.questionText, "求 x 的值。")
    let requests = SyntheticRecognitionProtocol.requests()
    XCTAssertEqual(requests.suffix(2).map { $0.httpBody }, [bytes, bytes])
    XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Idempotency-Key"), key.uuidString)
    XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-pairing-only")
    XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "X-Photo-Name"), "%E4%B8%AD%E6%96%87.jpg")
  }

  func testSyntheticCollectionReadUsesAuthenticatedGETAndDecodesJobs() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRecognitionProtocol.self]
    let client = RecognitionClient(configuration: try PairingConfiguration(baseURL: "http://localhost:3101", token: "synthetic-pairing-only"), sessionConfiguration: configuration)
    let jobs = try await client.listJobs()
    XCTAssertEqual(jobs.map(\.id), [Self.jobID])
    XCTAssertEqual(SyntheticRecognitionProtocol.requests().last?.httpMethod, "GET")
    XCTAssertEqual(SyntheticRecognitionProtocol.requests().last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-pairing-only")
  }

  func testRemoteIngestionDeduplicatesJobIDAndPreservesLocalSourceAndConfirmation() throws {
    var state = StudyState()
    let original = UUID().uuidString + ".jpg"
    try state.ingest(try Self.job(), photoName: original)
    try state.ingest(try Self.job(["\"revision\":8": "\"revision\":7", "\"status\":\"confirmed\"": "\"status\":\"ready\""]), photoName: UUID().uuidString + ".jpg")
    XCTAssertEqual(state.recognitionTasks.count, 1)
    XCTAssertEqual(state.recognitionTasks[0].photoName, original)
    XCTAssertEqual(state.realProblems.count, 1)
    XCTAssertEqual(state.recognitionTasks[0].job?.revision, 8)
  }

  func testHigherJobRevisionCannotRewriteSameQuestionRevision() throws {
    var state = StudyState()
    let name = UUID().uuidString + ".jpg"
    try state.ingest(try Self.job(), photoName: name)
    try state.ingest(try Self.job(["\"revision\":8": "\"revision\":9", "\"status\":\"confirmed\"": "\"status\":\"ready\""]), photoName: name)
    XCTAssertEqual(state.realProblems.count, 1)
    XCTAssertEqual(state.recognitionTasks.first?.job?.questions.first?.status, "confirmed")
  }
}

final class SyntheticRecognitionProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if let stream = request.httpBodyStream {
      stream.open()
      var bytes = Data()
      var buffer = [UInt8](repeating: 0, count: 1024)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        bytes.append(buffer, count: count)
      }
      stream.close()
      captured.httpBody = bytes
    }
    Self.lock.withLock { Self.recorded.append(captured) }
    let response = HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    let collection = request.httpMethod == "GET" && request.url?.path == "/v1/recognitions"
    client?.urlProtocol(self, didLoad: Data((collection ? "{\"jobs\":[" + RecognitionTests.fixture + "]}" : "{\"job\":" + RecognitionTests.fixture + "}").utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
