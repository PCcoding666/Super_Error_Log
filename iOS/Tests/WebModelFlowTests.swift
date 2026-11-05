import XCTest
import Foundation
@testable import StudentCore

// 视图模型的流程：上传队列、错题本筛选与撤销、录入分段、登录会话。假接口，不碰网络。

/// 可脚本化的假接口：记录调用顺序，按需让某些调用失败。
final class FakeWebAPI: WebAPI, @unchecked Sendable {
  private let lock = NSLock()
  private var _calls: [String] = []
  var calls: [String] { lock.withLock { _calls } }
  private func record(_ call: String) { lock.withLock { _calls.append(call) } }

  var notebookResult: @Sendable (NotebookQuery) async throws -> NotebookResponse = { _ in FakeWebAPI.notebook() }
  var discardResult: DiscardResponse = DiscardResponse(removed: [], failed: [])
  var modeResult: Result<UploadModeResponse, WebAPIError> = .success(UploadModeResponse(mode: "legacy", draftNamespace: nil))
  var uploadFailures: [UploadFailure] = []
  var intakeResult: IntakeResponse = IntakeResponse(mode: "legacy", draftNamespace: nil, photos: [], busy: false)
  private var uploadCounter = 0

  static func notebook(subject: String = "数学", items: [NotebookItem] = [], total: Int? = nil) -> NotebookResponse {
    NotebookResponse(subject: subject, subjects: ["数学", "物理"], grade: "初中", stages: ["初中", "高中"], chapter: "", chapters: [],
      status: "", tag: "", tags: [], q: "", total: total ?? items.count, shown: items.count, todo: items.count,
      groups: items.isEmpty ? [] : [NotebookGroup(key: "today", title: "今天", items: items)], finding: 0, pendingIntake: 0)
  }

  static func item(_ id: String) -> NotebookItem {
    NotebookItem(id: id, shortId: nil, subject: "数学", grade: "初中", chapter: "相似", knowledgeTags: [], excerpt: "题 \(id)",
      status: "todo", statusLabel: "待做", thumb: "/s/img/item/\(id)?s=thumb", intakeDay: "2026-10-25")
  }

  func notebook(_ query: NotebookQuery) async throws -> NotebookResponse { record("notebook \(query.subject)|\(query.grade)|\(query.chapter)|\(query.tag)|\(query.q)"); return try await notebookResult(query) }
  func item(id: String) async throws -> ItemDetailResponse { record("item \(id)"); throw WebAPIError.unreachable }
  func discard(ids: [String]) async throws -> DiscardResponse { record("discard \(ids.joined(separator: ","))"); return discardResult }
  func restore(id: String) async throws { record("restore \(id)") }
  func category(id: String, grade: String, subject: String, chapter: String) async throws { record("category \(id) \(grade) \(subject) \(chapter)") }
  func settings() async throws -> SettingsResponse { record("settings"); throw WebAPIError.unreachable }
  func setGrade(_ grade: String) async throws { record("grade \(grade)") }
  func intake() async throws -> IntakeResponse { record("intake"); return intakeResult }
  func uploadMode() async throws -> UploadModeResponse { record("mode"); return try modeResult.get() }
  func select(photoID: String, ids: [String]) async throws { record("select \(photoID) \(ids.sorted().joined(separator: ","))") }
  func retry(photoID: String) async throws { record("retry \(photoID)") }
  func dismiss(photoID: String) async throws { record("dismiss \(photoID)") }
  func imageData(serverPath: String) async throws -> Data { record("image \(serverPath)"); return Data() }

  private func nextUpload() throws -> Int {
    try lock.withLock {
      if !uploadFailures.isEmpty { throw uploadFailures.removeFirst() }
      uploadCounter += 1
      return uploadCounter
    }
  }
  func uploadLegacy(key: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    record("legacy \(key.prefix(4))")
    let number = try nextUpload()
    progress(1)
    return "job-\(number)"
  }
  func createMaterialsCapture(namespace: String, requestID: String) async throws -> String {
    record("capture \(namespace)")
    return "cap-1"
  }
  func uploadMaterials(namespace: String, captureID: String, uploadID: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    record("materials \(captureID)")
    let number = try nextUpload()
    return "asset-\(number)"
  }
}

@MainActor
final class UploadQueueTests: XCTestCase {
  private func waitIdle(_ queue: UploadQueue, timeout: Double = 10) async {
    let deadline = Date().addingTimeInterval(timeout)
    while queue.busy && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
  }

  private var photo: Data { ImagePreparerTests.makeImage(width: 600, height: 800) }

  func testPhotosUploadOneAtATimeAndJoinTheBatch() async {
    let api = FakeWebAPI()
    let queue = UploadQueue()
    queue.bind(api: api)
    queue.add([photo, photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.map(\.state), [.succeeded, .succeeded])
    XCTAssertEqual(queue.batchIDs, ["job-1", "job-2"])
    XCTAssertEqual(queue.succeededCount, 2)
    XCTAssertEqual(api.calls.filter { $0 == "mode" }.count, 1, "上传方式只问一次")
    XCTAssertTrue(queue.entries.allSatisfy { $0.message == "已上传 · AI 正在找题" })
  }

  func testMaterialsFlowCreatesOneCaptureForTheBatch() async {
    let api = FakeWebAPI()
    api.modeResult = .success(UploadModeResponse(mode: "materials", draftNamespace: "ns-1"))
    let queue = UploadQueue()
    queue.bind(api: api)
    queue.add([photo, photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.batchIDs, ["asset-1", "asset-2"])
    XCTAssertEqual(api.calls.filter { $0.hasPrefix("capture") }, ["capture ns-1"])
    XCTAssertEqual(api.calls.filter { $0.hasPrefix("materials") }, ["materials cap-1", "materials cap-1"])
  }

  func testRetryableFailureKeepsThePhotoAndRetriesWithoutDuplicates() async {
    let api = FakeWebAPI()
    api.uploadFailures = [UploadFailure.network]
    let queue = UploadQueue()
    queue.bind(api: api)
    queue.add([photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .failed)
    XCTAssertEqual(queue.entries.first?.retryable, true)
    XCTAssertEqual(queue.entries.first?.message, UploadFailure.network.message)
    XCTAssertTrue(queue.batchIDs.isEmpty)
    queue.retry()
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .succeeded)
    XCTAssertEqual(queue.batchIDs, ["job-1"])
    // 重试用的是同一个幂等 key
    let keys = api.calls.filter { $0.hasPrefix("legacy") }
    XCTAssertEqual(keys.count, 2)
    XCTAssertEqual(Set(keys).count, 1)
  }

  func testNonRetryableFailureDoesNotOfferRetry() async {
    let api = FakeWebAPI()
    api.uploadFailures = [UploadFailure(message: "这张图读不了。", retryable: false)]
    let queue = UploadQueue()
    queue.bind(api: api)
    queue.add([photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .failed)
    XCTAssertEqual(queue.entries.first?.retryable, false)
    queue.retry()
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .failed, "图片本身的问题不重试")
  }

  func testUnreadablePhotoFailsPreparationWithoutRetry() async {
    let queue = UploadQueue()
    queue.bind(api: FakeWebAPI())
    queue.add([Data("not an image".utf8)])
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .failed)
    XCTAssertEqual(queue.entries.first?.retryable, false)
  }

  func testModeLookupFailureIsRetryable() async {
    let api = FakeWebAPI()
    api.modeResult = .failure(.unreachable)
    let queue = UploadQueue()
    queue.bind(api: api)
    queue.add([photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .failed)
    XCTAssertEqual(queue.entries.first?.retryable, true)
    api.modeResult = .success(UploadModeResponse(mode: "legacy", draftNamespace: nil))
    queue.retry()
    await waitIdle(queue)
    XCTAssertEqual(queue.entries.first?.state, .succeeded)
  }

  func testFinishingTheBatchStartsAFreshOneNextTime() async {
    let queue = UploadQueue()
    queue.bind(api: FakeWebAPI())
    queue.add([photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.batchIDs, ["job-1"])
    queue.finishBatch()
    XCTAssertTrue(queue.entries.isEmpty)
    queue.add([photo])
    await waitIdle(queue)
    XCTAssertEqual(queue.batchIDs, ["job-2"], "新批次不带上一批")
  }

  func testBindingToANewAccountDropsTheOldBatch() async {
    let queue = UploadQueue()
    queue.bind(api: FakeWebAPI())
    queue.add([photo])
    await waitIdle(queue)
    queue.bind(api: FakeWebAPI())
    XCTAssertTrue(queue.entries.isEmpty)
    XCTAssertTrue(queue.batchIDs.isEmpty)
  }
}

@MainActor
final class NotebookModelTests: XCTestCase {
  func testChangingSubjectClearsEveryOtherFilter() async {
    let api = FakeWebAPI()
    let model = NotebookModel(api: api)
    model.query = NotebookQuery(subject: "数学", grade: "高中", chapter: "相似", tag: "判别式", q: "x")
    await model.setSubject("物理")
    XCTAssertEqual(model.query, NotebookQuery(subject: "物理"))
    XCTAssertEqual(api.calls.last, "notebook 物理||||")
  }

  func testChangingStageClearsChapterAndTagButKeepsSearch() async {
    let model = NotebookModel(api: FakeWebAPI())
    model.query = NotebookQuery(subject: "数学", grade: "初中", chapter: "相似", tag: "判别式", q: "x")
    await model.setStage("高中")
    XCTAssertEqual(model.query, NotebookQuery(subject: "数学", grade: "高中", chapter: "", tag: "", q: "x"))
  }

  func testStageRequiredIsSeparatedFromOtherProblems() async {
    let api = FakeWebAPI()
    api.notebookResult = { _ in throw WebAPIError(status: 409, code: "stage_required", message: "先选学段。") }
    let model = NotebookModel(api: api)
    await model.reload()
    XCTAssertTrue(model.stageRequired)
    XCTAssertNil(model.problem)
    api.notebookResult = { _ in FakeWebAPI.notebook(items: [FakeWebAPI.item("itm_a")]) }
    let message = await model.chooseStage("初中")
    XCTAssertNil(message)
    XCTAssertEqual(api.calls.contains("grade 初中"), true)
    XCTAssertFalse(model.stageRequired)
    XCTAssertEqual(model.items.map(\.id), ["itm_a"])
  }

  func testSubtitleShowsFilteredCount() async {
    let api = FakeWebAPI()
    api.notebookResult = { _ in FakeWebAPI.notebook(items: [FakeWebAPI.item("itm_a")], total: 5) }
    let model = NotebookModel(api: api)
    await model.reload()
    XCTAssertEqual(model.subtitle, "初中 · 5 道错题 · 显示 1 道")
  }

  func testDiscardReportsRemovedCountOffersUndoAndRefreshes() async {
    let api = FakeWebAPI()
    api.discardResult = DiscardResponse(removed: ["itm_a", "itm_b"], failed: [])
    let model = NotebookModel(api: api)
    model.startSelecting()
    model.toggle("itm_a")
    model.toggle("itm_b")
    XCTAssertEqual(model.selected, ["itm_a", "itm_b"])
    await model.discard(Array(model.selected).sorted())
    XCTAssertEqual(model.toast?.message, "已移除 2 道")
    XCTAssertEqual(model.toast?.undo, ["itm_a", "itm_b"])
    XCTAssertFalse(model.selecting)
    XCTAssertTrue(model.selected.isEmpty)
    XCTAssertEqual(api.calls.last?.hasPrefix("notebook"), true, "移除后刷新")
    await model.undo(["itm_a", "itm_b"])
    XCTAssertEqual(api.calls.filter { $0.hasPrefix("restore") }, ["restore itm_a", "restore itm_b"])
    XCTAssertNil(model.toast)
  }

  func testDiscardFailureShowsServerMessageWithoutUndo() async {
    let api = FakeWebAPI()
    api.discardResult = DiscardResponse(removed: [], failed: [DiscardFailure(id: "itm_a", message: "这道题不能移除。")])
    let model = NotebookModel(api: api)
    await model.discard(["itm_a"])
    XCTAssertEqual(model.toast?.message, "这道题不能移除。")
    XCTAssertNil(model.toast?.undo)
  }

  func testSlowOldResponseDoesNotOverwriteNewerFilter() async {
    let api = FakeWebAPI()
    api.notebookResult = { query in
      if query.q == "慢" { try await Task.sleep(for: .milliseconds(300)) }
      return FakeWebAPI.notebook(subject: query.q.isEmpty ? "新" : "旧")
    }
    let model = NotebookModel(api: api)
    model.query.q = "慢"
    async let slow: Void = model.reload()
    try? await Task.sleep(for: .milliseconds(50))
    model.query.q = ""
    await model.reload()
    await slow
    XCTAssertEqual(model.response?.subject, "新")
  }
}

@MainActor
final class IntakeModelTests: XCTestCase {
  private func photo(_ id: String, number: Int, at time: String, questions: Int = 0) -> IntakePhoto {
    IntakePhoto(id: id, number: number, takenAt: time, thumb: "/s/img/photo/\(id)", full: "/s/img/photo/\(id)?full=1", state: "done", statusText: "完成",
      questions: (0..<questions).map { IntakeQuestion(id: "itm_\(id)\($0)", excerpt: "题", chapter: "章", thumb: "/s/img/item/x") }, candidates: [], failure: nil)
  }

  func testCurrentBatchComesFirstSortedByTakenTime() async {
    let api = FakeWebAPI()
    api.intakeResult = IntakeResponse(mode: "legacy", draftNamespace: nil, photos: [
      photo("c", number: 3, at: "2026-10-25T03:00:00Z"),
      photo("b", number: 2, at: "2026-10-25T02:00:00Z", questions: 2),
      photo("a", number: 1, at: "2026-10-25T01:00:00Z"),
    ], busy: false)
    let uploads = UploadQueue()
    uploads.bind(api: api)
    let model = IntakeModel(api: api, uploads: uploads)
    await model.reload()
    XCTAssertEqual(model.current.map(\.id), ["c"], "没有本批时只展开最近一张")
    XCTAssertEqual(model.earlier.map(\.id), ["b", "a"])
    XCTAssertEqual(model.status, "这一批没有新增错题")
  }

  func testBatchPhotosAreExpandedAndCounted() async {
    let api = FakeWebAPI()
    let uploads = UploadQueue()
    uploads.bind(api: api)
    uploads.add([ImagePreparerTests.makeImage(width: 300, height: 400), ImagePreparerTests.makeImage(width: 300, height: 400)])
    let deadline = Date().addingTimeInterval(10)
    while uploads.busy && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    api.intakeResult = IntakeResponse(mode: "legacy", draftNamespace: nil, photos: [
      photo("job-2", number: 2, at: "2026-10-25T02:00:00Z", questions: 1),
      photo("job-1", number: 1, at: "2026-10-25T01:00:00Z", questions: 2),
      photo("old", number: 0, at: "2026-10-20T01:00:00Z", questions: 4),
    ], busy: false)
    let model = IntakeModel(api: api, uploads: uploads)
    await model.reload()
    XCTAssertEqual(model.current.map(\.id), ["job-1", "job-2"])
    XCTAssertEqual(model.earlier.map(\.id), ["old"])
    XCTAssertEqual(model.found, 3)
    XCTAssertEqual(model.status, "找到 3 道，已加入错题本 · 不相关的左滑删掉")
    XCTAssertFalse(model.busy)
  }

  func testUploadedButNotYetRegisteredPhotoKeepsPolling() async {
    let api = FakeWebAPI()
    let uploads = UploadQueue()
    uploads.bind(api: api)
    uploads.add([ImagePreparerTests.makeImage(width: 300, height: 400)])
    let deadline = Date().addingTimeInterval(10)
    while uploads.busy && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    let model = IntakeModel(api: api, uploads: uploads)
    await model.reload()
    XCTAssertTrue(model.busy, "刚传完、服务器列表里还没有这张：继续取")
    XCTAssertEqual(model.status, "AI 正在找题")
  }

  func testPickingCandidatesAndIncluding() async {
    let api = FakeWebAPI()
    let model = IntakeModel(api: api, uploads: UploadQueue())
    let page = IntakePhoto(id: "p1", number: 1, takenAt: "2026-10-25T01:00:00Z", thumb: "/t", full: "/f", state: "needsPick", statusText: "", questions: [],
      candidates: [IntakeCandidate(id: "c1", label: "第 1 题", excerpt: "", crop: nil), IntakeCandidate(id: "c2", label: "第 2 题", excerpt: "", crop: nil)], failure: nil)
    model.togglePick(photoID: "p1", candidateID: "c1")
    model.togglePick(photoID: "p1", candidateID: "c2")
    model.togglePick(photoID: "p1", candidateID: "c1")
    XCTAssertEqual(model.picked["p1"], ["c2"])
    await model.include(page)
    XCTAssertEqual(api.calls.first { $0.hasPrefix("select") }, "select p1 c2")
    XCTAssertEqual(model.picked["p1"], [])
    await model.include(page)
    XCTAssertEqual(api.calls.filter { $0.hasPrefix("select") }.count, 1, "没勾任何题不发请求")
  }
}

@MainActor
final class ItemModelTests: XCTestCase {
  private func model() -> (ItemModel, FakeWebAPI) {
    let api = FakeWebAPI()
    let model = ItemModel(itemID: "itm_a", api: api)
    return (model, api)
  }

  func testRetargetingDropsAChapterThatBelongsToTheOldSubject() async throws {
    let api = DetailAPI()
    let model = ItemModel(itemID: "itm_a", api: api)
    await model.reload()
    let draft = try XCTUnwrap(model.draft)
    XCTAssertEqual(draft, ItemModel.CategoryDraft(grade: "初中", subject: "数学", chapter: "相似"))
    XCTAssertEqual(model.chapters(for: draft), ["相似", "二次函数"])
    XCTAssertEqual(model.retarget(draft, subject: "物理").chapter, "", "数学章节不能存成物理的")
    XCTAssertEqual(model.retarget(draft, subject: "数学").chapter, "相似")
    XCTAssertEqual(model.retarget(draft, grade: "高中").chapter, "")
  }

  func testSavingCategoryPostsAndRefreshes() async {
    let api = DetailAPI()
    let model = ItemModel(itemID: "itm_a", api: api)
    await model.reload()
    let saved = await model.save(ItemModel.CategoryDraft(grade: "初中", subject: "数学", chapter: "二次函数"))
    XCTAssertTrue(saved)
    XCTAssertEqual(model.toast, "分类已更新")
    XCTAssertEqual(api.calls.filter { $0.hasPrefix("category") }, ["category itm_a 初中 数学 二次函数"])
  }

  func testDiscardFromDetail() async {
    let (model, api) = model()
    api.discardResult = DiscardResponse(removed: ["itm_a"], failed: [])
    let removed = await model.discard()
    XCTAssertTrue(removed)
    XCTAssertEqual(api.calls.last, "discard itm_a")
  }

  /// 能返回一份固定详情的假接口。
  final class DetailAPI: WebAPI, @unchecked Sendable {
    private let inner = FakeWebAPI()
    var calls: [String] { inner.calls }
    func notebook(_ query: NotebookQuery) async throws -> NotebookResponse { try await inner.notebook(query) }
    func item(id: String) async throws -> ItemDetailResponse {
      ItemDetailResponse(item: FakeWebAPI.item(id), questionText: "题干", badge: "ok", revision: 1, images: [], notes: [], canDiscard: true,
        category: ItemCategory(grade: "初中", subject: "数学", chapter: "相似", stages: ["初中", "高中"], subjects: ["数学", "物理"],
          chapterOptions: [ChapterOptions(grade: "初中", subject: "数学", chapters: ["相似", "二次函数"]), ChapterOptions(grade: "初中", subject: "物理", chapters: ["力"])]),
        materialUrl: nil)
    }
    func discard(ids: [String]) async throws -> DiscardResponse { try await inner.discard(ids: ids) }
    func restore(id: String) async throws { try await inner.restore(id: id) }
    func category(id: String, grade: String, subject: String, chapter: String) async throws { try await inner.category(id: id, grade: grade, subject: subject, chapter: chapter) }
    func settings() async throws -> SettingsResponse { try await inner.settings() }
    func setGrade(_ grade: String) async throws { try await inner.setGrade(grade) }
    func intake() async throws -> IntakeResponse { try await inner.intake() }
    func uploadMode() async throws -> UploadModeResponse { try await inner.uploadMode() }
    func select(photoID: String, ids: [String]) async throws { try await inner.select(photoID: photoID, ids: ids) }
    func retry(photoID: String) async throws { try await inner.retry(photoID: photoID) }
    func dismiss(photoID: String) async throws { try await inner.dismiss(photoID: photoID) }
    func imageData(serverPath: String) async throws -> Data { try await inner.imageData(serverPath: serverPath) }
    func uploadLegacy(key: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String { try await inner.uploadLegacy(key: key, jpeg: jpeg, progress: progress) }
    func createMaterialsCapture(namespace: String, requestID: String) async throws -> String { try await inner.createMaterialsCapture(namespace: namespace, requestID: requestID) }
    func uploadMaterials(namespace: String, captureID: String, uploadID: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
      try await inner.uploadMaterials(namespace: namespace, captureID: captureID, uploadID: uploadID, jpeg: jpeg, progress: progress)
    }
  }
}

final class MemoryCredentials: CredentialStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var value: PairingConfiguration?
  init(_ value: PairingConfiguration? = nil) { self.value = value }
  var current: PairingConfiguration? { lock.withLock { value } }
  func load() -> PairingConfiguration? { lock.withLock { value } }
  func save(_ configuration: PairingConfiguration) throws { lock.withLock { value = configuration } }
  func remove() { lock.withLock { value = nil } }
}

@MainActor
final class AccountSessionTests: XCTestCase {
  static let entry = "https://study.pccoding666.com/s/native"
  static let serviceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let token = "issued-session-token-32-bytes-test!!"

  nonisolated private static func authClient(_ configuration: PairingConfiguration) -> RecognitionClient {
    let session = URLSessionConfiguration.ephemeral
    session.protocolClasses = [InvitationSyntheticProtocol.self]
    return RecognitionClient(configuration: configuration, sessionConfiguration: session)
  }

  private func session(_ credentials: MemoryCredentials, api: FakeWebAPI = FakeWebAPI()) -> AccountSession {
    AccountSession(credentials: credentials, makeAPI: { _ in api }, makeAuthClient: { AccountSessionTests.authClient($0) })
  }

  func testLoginSavesCredentialsAndSwitchesToSignedIn() async throws {
    InvitationSyntheticProtocol.reset()
    let credentials = MemoryCredentials()
    let account = session(credentials)
    XCTAssertFalse(account.isLoggedIn)
    let ok = await account.login(code: "abcd-efgh-jk12")
    XCTAssertTrue(ok)
    XCTAssertTrue(account.isLoggedIn)
    XCTAssertEqual(credentials.current?.token, Self.token)
    XCTAssertEqual(credentials.current?.isInvitation, true)
    let request = try XCTUnwrap(InvitationSyntheticProtocol.requests().first)
    XCTAssertEqual(request.url?.absoluteString, "\(Self.entry)/login")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(body["code"] as? String, "ABCDEFGHJK12", "规范化后的码发给服务器")
  }

  func testWrongCodeShowsServerMessageAndStaysSignedOut() async {
    InvitationSyntheticProtocol.reset()
    InvitationSyntheticProtocol.overrideLogin(status: 400, body: #"{"error":{"code":"invalid_code","message":"邀请码不正确或已经失效。"}}"#)
    let credentials = MemoryCredentials()
    let account = session(credentials)
    let ok = await account.login(code: "ABCDEFGHJK12")
    XCTAssertFalse(ok)
    XCTAssertEqual(account.loginError, "邀请码不正确或已经失效。")
    XCTAssertNil(credentials.current)
    XCTAssertFalse(account.isLoggedIn)
  }

  func testSavedInvitationLoginIsRestoredButOldScanPairingIsNot() throws {
    let invitation = try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: nil)
    XCTAssertTrue(session(MemoryCredentials(invitation)).isLoggedIn)
    let cloud = try PairingConfiguration.cloud(baseURL: "https://study.pccoding666.com", serviceId: Self.serviceId, token: Self.token,
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb", expiresAt: nil)
    XCTAssertFalse(session(MemoryCredentials(cloud)).isLoggedIn, "旧扫码配对的接口已不在界面里")
  }

  func testUnauthorizedResponseSignsOutWithANotice() async throws {
    let invitation = try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: nil)
    let credentials = MemoryCredentials(invitation)
    let api = FakeWebAPI()
    api.notebookResult = { _ in throw WebAPIError(status: 401, code: "unauthorized", message: "登录已失效，请重新输入邀请码。") }
    let account = session(credentials, api: api)
    XCTAssertTrue(account.isLoggedIn)
    _ = try? await account.api?.notebook(NotebookQuery())
    for _ in 0..<50 where account.isLoggedIn { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertFalse(account.isLoggedIn)
    XCTAssertNil(credentials.current)
    XCTAssertEqual(account.notice, "登录已失效，请重新输入邀请码。")
  }

  func testLogoutRevokesTheTokenAndClearsEverything() async throws {
    InvitationSyntheticProtocol.reset()
    let invitation = try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: nil)
    let credentials = MemoryCredentials(invitation)
    let account = session(credentials)
    await account.logout()
    XCTAssertEqual(InvitationSyntheticProtocol.requests().last?.url?.absoluteString, "\(Self.entry)/logout")
    XCTAssertFalse(account.isLoggedIn)
    XCTAssertNil(credentials.current)
    XCTAssertNil(account.notice)
  }
}
