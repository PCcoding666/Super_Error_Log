import XCTest
import Foundation
@testable import StudentCore

// T6a RED: /v2 客户端。URLProtocol 合成传输，不连真实服务。
final class V2ClientTests: XCTestCase {
  static let jobId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let itemId = "itm_0a1b2c3d4e5f6071"
  static let otherItemId = "itm_1111111111111111"
  static let packetId = "pkt_1a2b3c4d5e6f7081"
  static let proposalId = "crp_a1b2c3d4e5f60718"
  static let clientRequestId = "099ea4a5-e4bf-4182-b986-a9fc7db383e9"
  static let token = "v2-synthetic-token-16"
  static let jpeg = Data([0xff, 0xd8, 0xff, 0xd9])

  override func setUp() { V2SyntheticProtocol.reset() }

  private func makeClient() throws -> V2Client {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [V2SyntheticProtocol.self]
    return V2Client(
      configuration: try PairingConfiguration(baseURL: "http://127.0.0.1:3197", token: Self.token),
      sessionConfiguration: configuration)
  }

  private func lastRequest(file: StaticString = #filePath, line: UInt = #line) throws -> URLRequest {
    try XCTUnwrap(V2SyntheticProtocol.requests().last, "expected a recorded request", file: file, line: line)
  }

  private func assertBearer(_ request: URLRequest, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(Self.token)", file: file, line: line)
  }

  private func bodyJSON(_ request: URLRequest, file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
    let data = try XCTUnwrap(request.httpBody, "expected a JSON body", file: file, line: line)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "body must be a JSON object", file: file, line: line)
  }

  // MARK: - 健康检查与登记

  func testHealthSendsBearerAndDecodesProtocolVersion() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/health", body: #"{"protocolVersion":2}"#)
    let health = try await makeClient().health()
    XCTAssertEqual(health.protocolVersion, 2)
    let request = try lastRequest()
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path, "/v2/health")
    assertBearer(request)
  }

  func testHealthRejectsWrongProtocolVersion() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/health", body: #"{"protocolVersion":1}"#)
    await assertThrowsInvalidResponse { try await self.makeClient().health() }
  }

  func testRegisterPhotoPostsEmptyBodyAndDecodes() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/photos/\(Self.jobId)/register",
      body: #"{"jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","registeredAt":"2026-09-30T08:15:00.123Z"}"#)
    let registration = try await makeClient().registerPhoto(jobId: Self.jobId)
    XCTAssertEqual(registration.jobId, Self.jobId)
    let request = try lastRequest()
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/v2/photos/\(Self.jobId)/register")
    assertBearer(request)
    XCTAssertTrue((request.httpBody ?? Data()).isEmpty, "登记接口无请求正文")
  }

  func testRegisterPhotoRejectsNonUUIDJobIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse { try await self.makeClient().registerPhoto(jobId: "not-a-uuid") }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty, "ID 形态不合法时不得发出请求")
  }

  // MARK: - 周视图与裁图

  func testWeekDecodesPhotosItemsAndBacklog() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/week", body: V2ModelTests.weekJSON)
    let week = try await makeClient().week()
    XCTAssertEqual(week.week, "2026-W40")
    XCTAssertEqual(week.items[0].status, .readyForReflection)
    XCTAssertEqual(week.photos[0].recognition, .done)
    let request = try lastRequest()
    XCTAssertEqual(request.httpMethod, "GET")
    assertBearer(request)
  }

  func testWeekToleratesUnknownItemStatusFromServer() async throws {
    let json = V2ModelTests.weekJSON.replacingOccurrences(of: "ready_for_reflection", with: "brand_new_state")
    V2SyntheticProtocol.respond("GET", "/v2/week", body: json)
    let week = try await makeClient().week()
    XCTAssertEqual(week.items[0].status, .unknown("brand_new_state"))
  }

  func testCropReturnsJPEGBytes() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/items/\(Self.itemId)/crop", body: Self.jpeg, contentType: "image/jpeg")
    let data = try await makeClient().crop(itemId: Self.itemId)
    XCTAssertEqual(data, Self.jpeg)
    assertBearer(try lastRequest())
  }

  func testCropRejectsNonJPEGContentType() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/items/\(Self.itemId)/crop", body: Self.jpeg, contentType: "text/plain")
    await assertThrowsInvalidResponse { try await self.makeClient().crop(itemId: Self.itemId) }
  }

  func testCropRejectsNonJPEGBytes() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/items/\(Self.itemId)/crop", body: Data("not-a-jpeg".utf8), contentType: "image/jpeg")
    await assertThrowsInvalidResponse { try await self.makeClient().crop(itemId: Self.itemId) }
  }

  func testItemIDRoutesRejectMalformedIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse { try await self.makeClient().crop(itemId: "itm_zzzz") }
    await assertThrowsInvalidResponse { try await self.makeClient().discard(itemId: "pkt_1a2b3c4d5e6f7081") }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  // MARK: - 不是错题 / 恢复

  func testDiscardPostsAndDecodesStatus() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/discard",
      body: #"{"id":"itm_0a1b2c3d4e5f6071","status":"archived_not_worth_review"}"#)
    let change = try await makeClient().discard(itemId: Self.itemId)
    XCTAssertEqual(change.status, .archivedNotWorthReview)
    XCTAssertEqual(try lastRequest().httpMethod, "POST")
  }

  func testRestorePostsAndDecodesStatus() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/restore",
      body: #"{"id":"itm_0a1b2c3d4e5f6071","status":"eligible_for_review"}"#)
    let change = try await makeClient().restore(itemId: Self.itemId)
    XCTAssertEqual(change.status, .eligibleForReview)
  }

  // MARK: - 设置

  func testGetSettingsDecodesDefaults() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/settings", body: #"{"practiceSlot":"本周内","paperLocation":"varies"}"#)
    let settings = try await makeClient().settings()
    XCTAssertEqual(settings.practiceSlot, "本周内")
    XCTAssertEqual(settings.paperLocation, .varies)
  }

  func testUpdateSettingsPutsBothFields() async throws {
    V2SyntheticProtocol.respond("PUT", "/v2/settings", body: #"{"practiceSlot":"周三晚自习","paperLocation":"school"}"#)
    let updated = try await makeClient().updateSettings(V2Settings(practiceSlot: "周三晚自习", paperLocation: .school))
    XCTAssertEqual(updated.paperLocation, .school)
    let request = try lastRequest()
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(request.url?.path, "/v2/settings")
    assertBearer(request)
    let body = try bodyJSON(request)
    XCTAssertEqual(body["practiceSlot"] as? String, "周三晚自习")
    XCTAssertEqual(body["paperLocation"] as? String, "school")
  }

  // MARK: - 推荐与练习

  func testRecommendDecodesCardsNotesAndLimits() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/recommend", body: #"{"recommended":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false}],"others":[],"notes":["本周可安排题目仅 3 道，不足 5 道，已全部纳入"],"limits":{"min":5,"max":8}}"#)
    let recommendation = try await makeClient().recommend()
    XCTAssertEqual(recommendation.recommended[0].tier, 4)
    XCTAssertEqual(recommendation.recommended[0].reason, "本周新错题")
    XCTAssertFalse(recommendation.recommended[0].reflected)
    XCTAssertEqual(recommendation.limits.min, 5)
    XCTAssertEqual(recommendation.limits.max, 8)
    XCTAssertEqual(recommendation.notes.count, 1)
    assertBearer(try lastRequest())
  }

  func testCreatePracticePostsItemIDsAndSlotAndDecodesDetail() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/practice", body: V2ClientTests.detailJSON)
    let detail = try await makeClient().createPractice(itemIds: [Self.itemId, Self.otherItemId], practiceSlot: "周三晚自习")
    XCTAssertEqual(detail.id, Self.packetId)
    XCTAssertEqual(detail.items[0].position, 0)
    XCTAssertNil(detail.generatedAt)
    let request = try lastRequest()
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/v2/practice")
    let body = try bodyJSON(request)
    XCTAssertEqual(body["itemIds"] as? [String], [Self.itemId, Self.otherItemId])
    XCTAssertEqual(body["practiceSlot"] as? String, "周三晚自习")
  }

  func testCreatePracticeOmitsNilSlot() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/practice", body: V2ClientTests.detailJSON)
    _ = try await makeClient().createPractice(itemIds: [Self.itemId], practiceSlot: nil)
    let body = try bodyJSON(lastRequest())
    XCTAssertNil(body["practiceSlot"])
  }

  func testCreatePracticeRejectsMalformedItemIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse { try await self.makeClient().createPractice(itemIds: ["bogus"], practiceSlot: nil) }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  func testPracticeListDecodesSummaries() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice", body: #"{"packets":[{"id":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","status":"scheduled","practiceSlot":"周三晚自习","createdAt":"2026-09-30T08:20:00.000Z","generatedAt":null,"itemCount":3}]}"#)
    let packets = try await makeClient().practiceList()
    XCTAssertEqual(packets.count, 1)
    XCTAssertEqual(packets[0].itemCount, 3)
    XCTAssertNil(packets[0].generatedAt)
    XCTAssertEqual(try lastRequest().httpMethod, "GET")
  }

  func testPracticeDetailDecodesFrozenTierAndReason() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)", body: V2ClientTests.detailJSON)
    let detail = try await makeClient().practiceDetail(id: Self.packetId)
    XCTAssertEqual(detail.items[0].tier, 4)
    XCTAssertEqual(detail.items[0].reason, "本周新错题")
    XCTAssertEqual(detail.items[0].status, .scheduled)
  }

  func testPracticeDetailRejectsMalformedPacketIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse { try await self.makeClient().practiceDetail(id: "pkt_xyz") }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  // MARK: - 打印

  func testRequestPrintAccepts202Preparing() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetId)/print", status: 202, body: #"{"status":"preparing"}"#)
    let state = try await makeClient().requestPrint(packetId: Self.packetId)
    XCTAssertEqual(state.status, .preparing)
    XCTAssertNil(state.snapshot)
    XCTAssertEqual(try lastRequest().httpMethod, "POST")
  }

  func testRequestPrintDecodesReadySnapshot() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetId)/print",
      body: #"{"status":"ready","snapshot":\#(V2ModelTests.snapshotJSON)}"#)
    let state = try await makeClient().requestPrint(packetId: Self.packetId)
    XCTAssertEqual(state.status, .ready)
    XCTAssertEqual(state.snapshot?.packetId, Self.packetId)
  }

  func testPrintStatusDecodesProgress() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)/print",
      body: #"{"status":"preparing","progress":{"done":1,"total":3}}"#)
    let state = try await makeClient().printStatus(packetId: Self.packetId)
    XCTAssertEqual(state.progress?.done, 1)
    XCTAssertEqual(state.progress?.total, 3)
  }

  func testPrintStatusDecodesFailedWithError() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)/print",
      body: #"{"status":"failed","error":"原图读不到"}"#)
    let state = try await makeClient().printStatus(packetId: Self.packetId)
    XCTAssertEqual(state.status, .failed)
    XCTAssertEqual(state.error, "原图读不到")
  }

  func testPrintMediaReturnsJPEGBytes() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)/print/media/p0-crop.jpg", body: Self.jpeg, contentType: "image/jpeg")
    let data = try await makeClient().printMedia(packetId: Self.packetId, name: "p0-crop.jpg")
    XCTAssertEqual(data, Self.jpeg)
    assertBearer(try lastRequest())
  }

  func testPrintMediaRejectsMalformedNameWithoutRequest() async throws {
    await assertThrowsInvalidResponse { try await self.makeClient().printMedia(packetId: Self.packetId, name: "P0-crop.jpg") }
    await assertThrowsInvalidResponse { try await self.makeClient().printMedia(packetId: Self.packetId, name: "p0-crop.png") }
    await assertThrowsInvalidResponse { try await self.makeClient().printMedia(packetId: Self.packetId, name: "../secret.jpg") }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  // MARK: - 回传与回报

  func testReturnPostsResultsAndDecodesPerItemOutcomes() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/practice/\(Self.packetId)/return",
      body: #"{"results":[{"itemId":"itm_0a1b2c3d4e5f6071","ok":true,"toStatus":"temporarily_mastered","reason":"延迟 3–7 天独立做对，进入暂时掌握"},{"itemId":"itm_1111111111111111","ok":false,"error":"实际作答日期不能是未来日期"}]}"#)
    let entry = V2ReturnEntry(itemId: Self.itemId, completion: .hint1, correct: true, performedOn: "2026-10-02", stuckStep: "移项")
    let response = try await makeClient().returnResults(packetId: Self.packetId, results: [entry])
    XCTAssertEqual(response.results.count, 2)
    XCTAssertTrue(response.results[0].ok)
    XCTAssertEqual(response.results[0].toStatus, .temporarilyMastered)
    XCTAssertFalse(response.results[1].ok)
    XCTAssertEqual(response.results[1].error, "实际作答日期不能是未来日期")
    let request = try lastRequest()
    XCTAssertEqual(request.url?.path, "/v2/practice/\(Self.packetId)/return")
    let body = try bodyJSON(request)
    let results = try XCTUnwrap(body["results"] as? [[String: Any]])
    XCTAssertEqual(results[0]["itemId"] as? String, Self.itemId)
    XCTAssertEqual(results[0]["completion"] as? String, "hint1")
    XCTAssertEqual(results[0]["correct"] as? Bool, true)
    XCTAssertEqual(results[0]["performedOn"] as? String, "2026-10-02")
    XCTAssertEqual(results[0]["stuckStep"] as? String, "移项")
  }

  func testPracticeSummaryDecodesReport() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)/summary", body: V2ModelTests.summaryJSON)
    let summary = try await makeClient().practiceSummary(packetId: Self.packetId)
    XCTAssertEqual(summary.answered, 3)
    XCTAssertEqual(summary.nextConfirmOn, "2026-10-10")
    XCTAssertEqual(summary.again[0].reason, "看了提示")
    assertBearer(try lastRequest())
  }

  // MARK: - 追问与复盘

  func testAskReflectionPostsAndDecodesQuestion() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/reflection/ask",
      body: #"{"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai"}"#)
    let question = try await makeClient().askReflection(itemId: Self.itemId)
    XCTAssertEqual(question.turn, 1)
    XCTAssertEqual(question.source, .ai)
    XCTAssertEqual(try lastRequest().httpMethod, "POST")
  }

  func testAnswerReflectionPostsAnswerAndDecodesSuggestion() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/reflection/answer",
      body: #"{"turn":1,"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错","secondQuestion":"等号另一边你是怎么处理的？"}"#)
    let result = try await makeClient().answerReflection(itemId: Self.itemId, answer: "我以为移项不用变号，直接就抄过来了")
    XCTAssertEqual(result.suggestedCause, "推理步骤")
    XCTAssertEqual(result.secondQuestion, "等号另一边你是怎么处理的？")
    let body = try bodyJSON(lastRequest())
    XCTAssertEqual(body["answer"] as? String, "我以为移项不用变号，直接就抄过来了")
  }

  func testSubmitReflectionPostsStudentChoicesAndDecodesRecord() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/reflection",
      body: #"{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"把移项当成了照抄，漏了变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z","status":"eligible_for_review"}"#)
    let submission = V2ReflectionSubmission(attemptState: "方法基本正确但步骤出错", cause: "推理步骤", masteryFeeling: 3, summary: "把移项当成了照抄，漏了变号")
    let record = try await makeClient().submitReflection(itemId: Self.itemId, submission: submission)
    XCTAssertEqual(record.id, "dia_9f8e7d6c5b4a3210")
    XCTAssertTrue(record.adoptedAi)
    XCTAssertEqual(record.status, .eligibleForReview)
    let body = try bodyJSON(lastRequest())
    XCTAssertEqual(body["attemptState"] as? String, "方法基本正确但步骤出错")
    XCTAssertEqual(body["cause"] as? String, "推理步骤")
    XCTAssertEqual(body["masteryFeeling"] as? Int, 3)
    XCTAssertEqual(body["summary"] as? String, "把移项当成了照抄，漏了变号")
  }

  func testReflectionDetailDecodesTurnsSuggestionAndRecord() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/items/\(Self.itemId)/reflection",
      body: #"{"turns":[{"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai","answer":"我以为移项不用变号，直接就抄过来了"}],"suggestion":{"summary":"把移项当成了照抄，漏了变号","suggestedCause":"推理步骤","suggestedAttemptState":"方法基本正确但步骤出错"},"reflection":{"id":"dia_9f8e7d6c5b4a3210","attemptState":"方法基本正确但步骤出错","cause":"推理步骤","masteryFeeling":3,"summary":"把移项当成了照抄，漏了变号","adoptedAi":true,"source":"v2","createdAt":"2026-09-30T08:25:00.000Z"}}"#)
    let detail = try await makeClient().reflectionDetail(itemId: Self.itemId)
    XCTAssertEqual(detail.turns[0].answer, "我以为移项不用变号，直接就抄过来了")
    XCTAssertEqual(detail.suggestion?.suggestedCause, "推理步骤")
    XCTAssertEqual(detail.reflection?.masteryFeeling, 3)
  }

  // MARK: - 识别结果视图与修改

  func testEvidenceDecodesRevisionAndObservations() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/items/\(Self.itemId)/evidence",
      body: #"{"questionText":"已知 x+y=1，求 x 的值。","subject":"数学","knowledgeTags":["一元一次方程"],"observations":[{"id":"o1","kind":"student_work","text":"x=1"}],"badge":"ok","revision":1}"#)
    let evidence = try await makeClient().evidence(itemId: Self.itemId)
    XCTAssertEqual(evidence.revision, 1)
    XCTAssertEqual(evidence.observations[0].kind, "student_work")
    XCTAssertEqual(evidence.badge, .ok)
  }

  func testProposeCorrectionPostsAllFieldsAndDecodesProposal() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct",
      body: #"{"proposalId":"crp_a1b2c3d4e5f60718","revision":1,"changes":[{"field":"questionText","before":"已知 x+y=1，求 x 的值。","after":"已知 x+y=1，求 y 的值。","find":"x 的值","replace":"y 的值"}],"clarify":null}"#)
    let proposal = try await makeClient().proposeCorrection(itemId: Self.itemId, instruction: "题目求的是 y 不是 x", method: .voice, revision: 1, clientRequestId: Self.clientRequestId)
    XCTAssertEqual(proposal.proposalId, Self.proposalId)
    XCTAssertEqual(proposal.changes[0].field, .questionText)
    XCTAssertEqual(proposal.changes[0].replace, "y 的值")
    XCTAssertNil(proposal.clarify)
    let body = try bodyJSON(lastRequest())
    XCTAssertEqual(body["instruction"] as? String, "题目求的是 y 不是 x")
    XCTAssertEqual(body["method"] as? String, "voice")
    XCTAssertEqual(body["revision"] as? Int, 1)
    XCTAssertEqual(body["clientRequestId"] as? String, Self.clientRequestId)
  }

  func testProposeCorrectionRejectsMalformedClientRequestIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse {
      try await self.makeClient().proposeCorrection(itemId: Self.itemId, instruction: "改一下", method: .keyboard, revision: 1, clientRequestId: "not-a-uuid")
    }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  func testAcceptCorrectionPostsProposalAndRevision() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct/accept",
      body: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 y 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let acceptance = try await makeClient().acceptCorrection(itemId: Self.itemId, proposalId: Self.proposalId, revision: 1)
    XCTAssertEqual(acceptance.revision, 2)
    XCTAssertEqual(acceptance.card.questionExcerpt, "已知 x+y=1，求 y 的值。")
    let body = try bodyJSON(lastRequest())
    XCTAssertEqual(body["proposalId"] as? String, Self.proposalId)
    XCTAssertEqual(body["revision"] as? Int, 1)
  }

  func testAcceptCorrectionRejectsMalformedProposalIDWithoutRequest() async throws {
    await assertThrowsInvalidResponse {
      try await self.makeClient().acceptCorrection(itemId: Self.itemId, proposalId: "itm_0a1b2c3d4e5f6071", revision: 1)
    }
    XCTAssertTrue(V2SyntheticProtocol.requests().isEmpty)
  }

  func testDirectCorrectionPostsRevisionAndChanges() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct/direct",
      body: #"{"revision":2,"card":{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"物理","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"ready_for_reflection","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0"}}"#)
    let change = V2CorrectionChange(field: .subject, observationId: nil, before: "数学", after: "物理", find: nil, replace: nil)
    let acceptance = try await makeClient().correctDirectly(itemId: Self.itemId, revision: 1, changes: [change])
    XCTAssertEqual(acceptance.revision, 2)
    XCTAssertEqual(acceptance.card.subject, "物理")
    let body = try bodyJSON(lastRequest())
    XCTAssertEqual(body["revision"] as? Int, 1)
    let changes = try XCTUnwrap(body["changes"] as? [[String: Any]])
    XCTAssertEqual(changes[0]["field"] as? String, "subject")
    XCTAssertEqual(changes[0]["before"] as? String, "数学")
    XCTAssertEqual(changes[0]["after"] as? String, "物理")
  }

  // MARK: - 修改报告

  func testCorrectionsReportDecodesWeeksAndRates() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/corrections/report",
      body: #"{"weeks":[{"week":"2026-W40","itemCount":3,"fields":[{"field":"questionText","corrected":1,"total":3,"rate":0.3333333333333333},{"field":"student_work","corrected":0,"total":3,"rate":0}],"notAMistake":{"count":0,"rate":0}}]}"#)
    let report = try await makeClient().correctionsReport()
    XCTAssertEqual(report.weeks[0].week, "2026-W40")
    XCTAssertEqual(report.weeks[0].fields[0].corrected, 1)
    XCTAssertEqual(report.weeks[0].fields[0].rate, 0.3333333333333333, accuracy: 1e-9)
    XCTAssertEqual(report.weeks[0].notAMistake.count, 0)
    assertBearer(try lastRequest())
  }

  // MARK: - 错误映射

  func testUnauthorizedMapsToServerErrorWithTokenRedacted() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/week", status: 401,
      body: #"{"error":{"code":"unauthorized","message":"令牌 v2-synthetic-token-16 无效。"}}"#)
    do {
      _ = try await makeClient().week()
      XCTFail("401 must throw")
    } catch RecognitionClientError.server(let status, let message) {
      XCTAssertEqual(status, 401)
      XCTAssertFalse(message.contains(Self.token), "令牌不得出现在错误文案里")
      XCTAssertTrue(message.contains("[已隐藏]"))
    } catch { XCTFail("expected .server, got \(error)") }
  }

  func testNotFoundMapsToServerError() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/practice/\(Self.packetId)", status: 404,
      body: #"{"error":{"code":"not_found","message":"练习不存在。"}}"#)
    do {
      _ = try await makeClient().practiceDetail(id: Self.packetId)
      XCTFail("404 must throw")
    } catch RecognitionClientError.server(let status, let message) {
      XCTAssertEqual(status, 404)
      XCTAssertEqual(message, "练习不存在。")
    } catch { XCTFail("expected .server, got \(error)") }
  }

  func testPlainConflictMapsToServerError() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/discard", status: 409,
      body: #"{"error":{"code":"conflict","message":"当前状态不能标记为“不是错题”。"}}"#)
    do {
      _ = try await makeClient().discard(itemId: Self.itemId)
      XCTFail("409 must throw")
    } catch RecognitionClientError.server(let status, let message) {
      XCTAssertEqual(status, 409)
      XCTAssertEqual(message, "当前状态不能标记为“不是错题”。")
    } catch { XCTFail("expected .server, got \(error)") }
  }

  func testRevisionConflictCarriesCurrentRevision() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct/accept", status: 409,
      body: #"{"error":{"code":"conflict","message":"识别结果已更新，该建议已失效。"},"revision":3}"#)
    do {
      _ = try await makeClient().acceptCorrection(itemId: Self.itemId, proposalId: Self.proposalId, revision: 1)
      XCTFail("409 with revision must throw")
    } catch V2ClientError.revisionConflict(let message, let currentRevision) {
      XCTAssertEqual(message, "识别结果已更新，该建议已失效。")
      XCTAssertEqual(currentRevision, 3)
    } catch { XCTFail("expected .revisionConflict, got \(error)") }
  }

  func testRateLimitedMapsToServerError() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct", status: 429,
      body: #"{"error":{"code":"rate_limited","message":"这题改得太频繁了，请一小时后再试，或用键盘直接改。"}}"#)
    do {
      _ = try await makeClient().proposeCorrection(itemId: Self.itemId, instruction: "改一下", method: .voice, revision: 1, clientRequestId: Self.clientRequestId)
      XCTFail("429 must throw")
    } catch RecognitionClientError.server(let status, let message) {
      XCTAssertEqual(status, 429)
      XCTAssertEqual(message, "这题改得太频繁了，请一小时后再试，或用键盘直接改。")
    } catch { XCTFail("expected .server, got \(error)") }
  }

  func testBadGatewayMapsToServerError() async throws {
    V2SyntheticProtocol.respond("POST", "/v2/items/\(Self.itemId)/correct", status: 502,
      body: #"{"error":{"code":"bad_gateway","message":"这次没生成出可用的修改，请换个说法或用键盘直接改"}}"#)
    do {
      _ = try await makeClient().proposeCorrection(itemId: Self.itemId, instruction: "改一下", method: .voice, revision: 1, clientRequestId: Self.clientRequestId)
      XCTFail("502 must throw")
    } catch RecognitionClientError.server(let status, let message) {
      XCTAssertEqual(status, 502)
      XCTAssertEqual(message, "这次没生成出可用的修改，请换个说法或用键盘直接改")
    } catch { XCTFail("expected .server, got \(error)") }
  }

  func testMalformedSuccessBodyIsInvalidResponse() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/week", body: "not json at all")
    await assertThrowsInvalidResponse { try await self.makeClient().week() }
  }

  func testRedirectIsNotFollowed() async throws {
    V2SyntheticProtocol.respond("GET", "/v2/week", status: 301, body: "", headers: ["Location": "http://127.0.0.1:3197/v2/elsewhere"])
    do {
      _ = try await makeClient().week()
      XCTFail("redirect must not be silently followed")
    } catch RecognitionClientError.server(let status, _) {
      XCTAssertEqual(status, 301, "拒绝重定向后应把 301 原样作为错误呈现")
    } catch { XCTFail("expected .server(301), got \(error)") }
    XCTAssertEqual(V2SyntheticProtocol.requests().count, 1, "不得跟随重定向发出第二个请求")
  }

  // MARK: - 工具

  private func assertThrowsInvalidResponse(_ body: () async throws -> some Any, file: StaticString = #filePath, line: UInt = #line) async {
    do {
      _ = try await body()
      XCTFail("expected invalidResponse", file: file, line: line)
    } catch RecognitionClientError.invalidResponse {
    } catch { XCTFail("expected .invalidResponse, got \(error)", file: file, line: line) }
  }

  static let detailJSON = #"{"id":"pkt_1a2b3c4d5e6f7081","week":"2026-W40","status":"scheduled","practiceSlot":"周三晚自习","createdAt":"2026-09-30T08:20:00.000Z","generatedAt":null,"items":[{"id":"itm_0a1b2c3d4e5f6071","shortId":"M-12","subject":"数学","knowledgeTags":["一元一次方程"],"questionExcerpt":"已知 x+y=1，求 x 的值。","badge":"ok","status":"scheduled","cropUrl":"/v2/items/itm_0a1b2c3d4e5f6071/crop","jobId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","reason":"本周新错题","tier":4,"reflected":false,"position":0}]}"#
}

/// 合成 /v2 传输：按 "METHOD /path" 路由表回应，记录请求（含正文）。
final class V2SyntheticProtocol: URLProtocol, @unchecked Sendable {
  private struct Route {
    let status: Int
    let body: Data
    let contentType: String
    let headers: [String: String]
  }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  nonisolated(unsafe) private static var routes: [String: Route] = [:]

  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  static func reset() { lock.withLock { recorded = []; routes = [:] } }
  static func respond(_ method: String, _ path: String, status: Int = 200, body: String, contentType: String = "application/json", headers: [String: String] = [:]) {
    respond(method, path, status: status, body: Data(body.utf8), contentType: contentType, headers: headers)
  }
  static func respond(_ method: String, _ path: String, status: Int = 200, body: Data, contentType: String, headers: [String: String] = [:]) {
    lock.withLock {
      routes[method + " " + path] = Route(status: status, body: body, contentType: contentType, headers: headers)
    }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var captured = request
    if let stream = request.httpBodyStream {
      stream.open()
      var bytes = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        bytes.append(buffer, count: count)
      }
      stream.close()
      captured.httpBody = bytes
    }
    Self.lock.withLock { Self.recorded.append(captured) }
    let key = (request.httpMethod ?? "GET") + " " + (request.url?.path ?? "")
    let route = Self.lock.withLock { Self.routes[key] }
      ?? Route(status: 404, body: Data(#"{"error":{"code":"not_found","message":"接口不存在。"}}"#.utf8), contentType: "application/json", headers: [:])
    var headerFields = route.headers
    if !route.contentType.isEmpty { headerFields["Content-Type"] = route.contentType }
    let response = HTTPURLResponse(url: request.url!, statusCode: route.status, httpVersion: nil, headerFields: headerFields)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: route.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
