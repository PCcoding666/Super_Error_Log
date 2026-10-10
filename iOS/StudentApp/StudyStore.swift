import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif
import ImageIO

#if DEBUG
/// Task 5 UI 测试注入常量（仅 DEBUG；与 UITests/SyntheticRecognitionServer 的合成契约一致）。
enum CloudPairingTestFixtures {
  static let serviceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let httpsUrl = "https://study.pccoding666.com"
  static let sessionId = "099ea4a5-e4bf-4182-b986-a9fc7db383e9"
  static let secret = "2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0"
}
#endif

@MainActor @Observable
final class StudyStore {
  private(set) var state = StudyState()
  private(set) var cannotLoad = false
  var errorMessage: String?
  let persistence: StudyPersistence
  private(set) var pairing: PairingConfiguration?
  private(set) var busyTasks: Set<UUID> = []
  /// 各任务的上传进度（0.0–1.0）；无键表示不在上传中。
  private(set) var uploadProgress: [UUID: Double] = [:]
  private(set) var mediaRevision = 0
  private(set) var readableMedia: Set<URL> = []
  // Task 4: 连接状态机（云端模式；回环模式保持 nil，由既有 UI 表达）。
  private(set) var connectionState: ConnectionState?
  private var connectionTracker = ConnectionTracker()
  private var connectionGeneration = 0
  private var lastConnectionCheck: Date?
  private var connectionCheckInFlight: Task<Void, Never>?
  #if DEBUG
  /// Task 5 UI 测试注入防抖：自动兑换每进程只发起一次（phase 变化会重复触发 loadPairing）。
  private var cloudAutoRedeemStarted = false
  #endif
  private var isActive = false
  private var client: RecognitionClient?
  /// T6b：与 client 同一份配对的 /v2 客户端（登记进学习闭环）；配对变化时一起重建/关闭。
  /// T6c：改为 private(set)，供 App 根把它接给 LoopStore（不另建会话）。
  private(set) var v2Client: V2Client?
  private var polling: Task<Void, Never>?

  init(persistence suppliedPersistence: StudyPersistence? = nil, client suppliedClient: RecognitionClient? = nil,
    v2Client suppliedV2Client: V2Client? = nil) {
    var directory = URL.applicationSupportDirectory.appendingPathComponent(
      "StudentExperience", isDirectory: true)
    #if DEBUG
      // UI tests get their own collection. Never reset the normal student collection.
      let arguments = ProcessInfo.processInfo.arguments
      if let index = arguments.firstIndex(of: "-test-session"),
        arguments.indices.contains(index + 1),
        let id = UUID(uuidString: arguments[index + 1])
      {
        directory = URL.applicationSupportDirectory.appendingPathComponent(
          "UITest-\(id.uuidString)", isDirectory: true)
      }
    #endif
    persistence = suppliedPersistence ?? StudyPersistence(directory: directory)
    reload()
    if let suppliedClient {
      client = suppliedClient
      pairing = suppliedClient.configuration
      v2Client = suppliedV2Client
    }
    else { loadPairing() }
  }

  /// T6c：上传同意只问一次（按数据集合隔离保存在 study-state.json）。
  var hasUploadConsent: Bool { state.uploadConsentGranted }
  /// 同意说明的肯定动作调用；记住之后新加的照片自动上传，不再弹。
  func grantUploadConsent() { _ = change { $0.uploadConsentGranted = true } }
  var photoDirectory: URL {
    persistence.directory.appendingPathComponent("Photos", isDirectory: true)
  }

  func reload() {
    do {
      try persistence.prepareDirectory()
      state = try persistence.load()
      cannotLoad = false
      readableMedia = []
      Task { await validateSavedMedia() }
    } catch {
      cannotLoad = true
      errorMessage =
        "无法打开已保存的学习内容，没有覆盖任何数据。\(error.localizedDescription)"
    }
  }

  @discardableResult
  private func change(_ update: (inout StudyState) throws -> Void) -> Bool {
    guard !cannotLoad else { return false }
    do {
      var next = state
      try update(&next)
      try persistence.save(next)
      state = next
      return true
    } catch {
      errorMessage =
        "无法保存这次修改，请重试。\(error.localizedDescription)"
      return false
    }
  }

  func photoURL(_ name: String) -> URL { photoDirectory.appendingPathComponent(name) }

  func originalURL(_ name: String) -> URL {
    let original = photoDirectory.appendingPathComponent(String(name.dropLast(4)) + ".source")
    return FileManager.default.fileExists(atPath: original.path) ? original : photoURL(name)
  }

  func loadPairing() {
    do {
      #if DEBUG
      try PairingStore.consumeBootstrap(in: persistence.directory)
      #endif
      let saved = try PairingStore.load(scope: persistence.directory.lastPathComponent)
      // 幂等：磁盘上的配对与当前一致（云模式自动兑换后 phase 变化会再次触发 loadPairing）
      // 时不重建客户端——重建会作废在途请求（health/上传中途被 invalidate 导致崩溃）。
      if saved != pairing {
        client?.close()
        v2Client?.close()
        pairing = saved
        client = pairing.map { RecognitionClient(configuration: $0) }
        v2Client = pairing.map { V2Client(configuration: $0) }
        if pairing?.isCloud == true {
          connectionTracker = ConnectionTracker()
          connectionGeneration = connectionTracker.paired()
          connectionState = .pairedNeedsCheck
        } else { connectionState = nil }
      }
    } catch { errorMessage = "无法读取配对信息，请在连接设置中重新输入。" }
    #if DEBUG
    // Task 5 UI 测试注入：`-cloud-loopback` 存在且尚未配对时，用合成二维码自动兑换
    //（redeem 免鉴权；合成服务器只在测试进程内监听回环端口）。真实启动不受影响：
    // 覆盖仅 DEBUG 存在，且只在没有任何配对时触发；每进程至多一次，防止 phase
    // 变化重复触发双重兑换/双重 close。
    if pairing == nil, !cloudAutoRedeemStarted, PairingConfiguration.testCloudOverride != nil {
      cloudAutoRedeemStarted = true
      let qr = #"{"v":1,"serviceId":"\#(CloudPairingTestFixtures.serviceId)","httpsUrl":"\#(CloudPairingTestFixtures.httpsUrl)","sessionId":"\#(CloudPairingTestFixtures.sessionId)","secret":"\#(CloudPairingTestFixtures.secret)"}"#
      Task { await redeemCloudPairing(qrText: qr) }
    }
    #endif
  }

  /// 云端配对落库（扫码兑换成功后调用）。同 service 重配触发代次 +1，迟到旧响应按代次丢弃。
  func adoptCloudPairing(_ configuration: PairingConfiguration) {
    if pairing == configuration { return } // 幂等：重复兑换同一结果不重建会话。
    client?.close()
    v2Client?.close()
    client = RecognitionClient(configuration: configuration)
    v2Client = V2Client(configuration: configuration)
    pairing = configuration
    connectionTracker = ConnectionTracker()
    connectionGeneration = connectionTracker.paired()
    connectionState = .pairedNeedsCheck
    do { try PairingStore.save(configuration, scope: persistence.directory.lastPathComponent) }
    catch { errorMessage = "配对信息未保存，请解锁设备后重试。" }
    resumePolling()
    // 配对成功即自动做首次健康检查（不需要用户再点一次「检查连接」）。
    Task { await checkConnection(force: true) }
  }

  /// Task 5：扫码配对——解析二维码 → 兑换设备令牌 → 落库。
  /// 兑换失败时把服务器的中文错误透传给用户（不含任何令牌字节）。
  /// `transport`：测试注入合成传输（默认自建占位客户端；redeem 免鉴权）。
  func redeemCloudPairing(qrText: String, transport: RecognitionClient? = nil) async {
    let qr: CloudPairing.ParsedQR
    do { qr = try CloudPairing.parse(qrText) }
    catch { errorMessage = (error as? CloudPairing.QRParseError)?.errorDescription ?? "二维码无法识别，请重新扫码。"; return }
    // 兑换免鉴权：默认用占位云配置发起（redeem 不携带 Authorization 头），发往二维码里的入口。
    let client: RecognitionClient
    let ownsClient: Bool
    if let transport { client = transport; ownsClient = false }
    else if let bootstrap = try? PairingConfiguration.cloud(
      baseURL: qr.httpsUrl, serviceId: qr.serviceId, token: String(repeating: "x", count: 32),
      deviceId: UUID().uuidString, expiresAt: nil) {
      client = RecognitionClient(configuration: bootstrap); ownsClient = true
    } else { errorMessage = "配对请求无法构造，请重试。"; return }
    defer { if ownsClient { client.close() } }
    do {
      // clientId 按安装稳定：响应在网络丢失后重试时，服务端按同 clientId 幂等返回
      // 同一设备令牌（换新 clientId 会得到 pairing_used 409，无法恢复）。
      let result = try await client.redeem(qr: qr, clientId: Self.clientIdentifier, deviceInfo: "iPhone")
      // 之后的请求都走扫码时的入口（IP 直连或域名）；换入口须重新扫码。
      let configuration = try PairingConfiguration.cloud(
        baseURL: qr.httpsUrl, serviceId: result.serviceId, token: result.token,
        deviceId: result.deviceId, expiresAt: result.expiresAt)
      adoptCloudPairing(configuration)
    } catch { errorMessage = error.localizedDescription }
  }

  /// 设备级客户端标识（非秘密；服务端兑换幂等键）。首次使用生成后稳定保存。
  private static let clientIdentifier: String = {
    let key = "sel-client-identifier"
    if let existing = UserDefaults.standard.string(forKey: key) { return existing }
    let fresh = UUID().uuidString
    UserDefaults.standard.set(fresh, forKey: key)
    return fresh
  }()

  /// Task 5 UI：连接操作入口。unauthorized/incompatible → 重新配对（清空凭据，UI 随后弹出扫码页）；
  /// 其余非 ready 态 → 强制重查（`.failed` 仍然只是「重试」，不会清凭据）。
  func connectionAction() async {
    switch connectionState {
    case .unauthorized, .incompatible:
      // 重新配对入口由 UI 呈现扫码页；这里先清凭据回到未配对态。
      repairByRescan()
    case .ready, .busy, .failed, .pairedNeedsCheck, .checking, .unpaired, .none:
      _ = await checkConnection(force: true)
    }
  }

  /// 清掉已保存的配对回到未配对态，不看当前连接状态（调用方随后弹出扫码页）。
  /// 授权失效 / 版本不兼容走这里；连不上服务器（`.failed`，例如换了网络后旧入口不通）时，
  /// 学生也可以主动「重新扫码」换一个入口，所以这里不能只认 unauthorized/incompatible。
  /// 代次 +1，迟到的旧响应一律丢弃；只删钥匙串里的配对，本机照片与学习记录不动。
  func repairByRescan() {
    _ = connectionTracker.repair()
    connectionGeneration += 1
    connectionState = .unpaired
    PairingStore.remove(scope: persistence.directory.lastPathComponent)
    client?.close(); client = nil; pairing = nil
    v2Client?.close(); v2Client = nil
  }

  /// 连接检查：合并并发检查；30 秒缓存仅用于状态显示。
  /// `force=true`（每批提交前、回前台、打开确认页）绕过缓存强制重查。
  /// 后台、网络失败、授权失效会立即清除 ready 状态（由 classify 输出非 ready 态实现）。
  @discardableResult
  func checkConnection(force: Bool = false) async -> ConnectionState? {
    guard pairing?.isCloud == true, let client else { return nil }
    if !force, let lastConnectionCheck, Date().timeIntervalSince(lastConnectionCheck) < 30,
      connectionState == .ready || connectionState == .busy || connectionState == .failed
    { return connectionState }
    if let connectionCheckInFlight { await connectionCheckInFlight.value; return connectionState }
    let completion = connectionTracker.beginCheck()
    let generation = connectionGeneration
    connectionState = .checking
    let task = Task<Void, Never> { [weak self] in
      do {
        let snapshot = try await client.health()
        guard let self, self.connectionGeneration == generation else { return } // 迟到响应：丢弃
        if snapshot.acceptingJobs { completion(.success(true)) }
        else { completion(.success(false)) }
      } catch {
        guard let self, self.connectionGeneration == generation else { return }
        completion(.failure(error))
      }
      guard let self, self.connectionGeneration == generation else { return }
      self.lastConnectionCheck = Date()
      self.connectionState = self.connectionTracker.currentState
    }
    connectionCheckInFlight = task
    await task.value
    connectionCheckInFlight = nil
    return connectionState
  }

  /// 供 UI 使用的上传门槛：云端必须 ready（force 重查）；回环沿用旧语义（已配对即可）。
  func canSubmitNow() async -> Bool {
    guard pairing != nil else { return false }
    if pairing?.isCloud == true {
      return await checkConnection(force: true) == .ready
    }
    return true
  }

  func savePairing(address: String, token: String) -> Bool {
    do {
      let pairing = try PairingConfiguration(baseURL: address, token: token)
      try PairingStore.save(pairing, scope: persistence.directory.lastPathComponent)
      self.pairing = pairing
      client?.close(); client = RecognitionClient(configuration: pairing)
      v2Client?.close(); v2Client = V2Client(configuration: pairing)
      resumePolling()
      return true
    } catch { errorMessage = error.localizedDescription; return false }
  }

  func resumePolling() {
    polling?.cancel()
    guard isActive else { polling = nil; return }
    polling = Task { [weak self] in
      guard let self, isActive, !Task.isCancelled else { return }
      await refreshJobs(requireActive: true)
      while isActive && !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(3)) } catch { break }
        guard isActive, !Task.isCancelled else { break }
        await refreshJobs(onlyActive: true, requireActive: true)
      }
    }
  }
  func pausePolling() { polling?.cancel(); polling = nil }
  func setActive(_ active: Bool) {
    isActive = active
    if active { resumePolling() } else { pausePolling() }
  }

  func refreshJobs(onlyActive: Bool = false, requireActive: Bool = false) async {
    guard let client, !cannotLoad, !requireActive || isActive else { return }
    // T6b：补登记——已有任务、尚未登记成功（nil）、归属当前服务的任务，直到成功。
    // 与识别进度刷新独立，不看 onlyActive（登记是进学习闭环的门槛）。
    // T6c：一轮里遇到第一个非 404 的失败就停止本轮补登记（下次刷新再试），
    // 避免服务异常时每次轮询都把所有未登记任务请求一遍。
    for task in state.recognitionTasks where task.v2Registered == nil && task.job != nil
      && (pairing?.isCloud != true || task.ownedServiceId == pairing?.serviceId) {
      guard !Task.isCancelled, !requireActive || isActive else { return }
      guard let jobID = task.job?.id else { continue }
      if await registerV2(jobID: jobID, taskID: task.id) == .failed { break }
    }
    let tasks = state.recognitionTasks.filter { task in
      // 云端模式：只刷新归属当前服务的任务（随任务持久化，重启后依然有效）；
      // 旧 Mac 来源（ownedServiceId != 当前服务）仅离线可看。
      task.job != nil && (pairing?.isCloud != true || task.ownedServiceId == pairing?.serviceId)
        && (!onlyActive || task.job?.active == true)
    }
    for task in tasks {
      guard !Task.isCancelled, !requireActive || isActive, let job = task.job else { return }
      do {
        let updated = try await client.getJob(job.id)
        guard !Task.isCancelled, !requireActive || isActive else { return }
        if change({ state in
          try state.ingest(updated, photoName: task.photoName)
          // 刷新成功：清除该任务此前的失败分类与文案。
          if let index = state.recognitionTasks.firstIndex(where: { $0.id == task.id }) {
            state.recognitionTasks[index].lastIssueKind = nil
          }
        }) {
          try await cacheMedia(updated, client: client)
        }
      } catch {
        if !Task.isCancelled { change { state in
          if let index = state.recognitionTasks.firstIndex(where: { $0.id == task.id }) {
            state.recognitionTasks[index].lastError = error.localizedDescription
            // M1：分类失败原因（离线/服务暂不可用/配对失效/未知），卡片据此显示
            // 「进度暂未更新」而不是把任务误报为识别失败。
            state.recognitionTasks[index].lastIssueKind = TaskPresentation.classifyRefreshIssue(error)
          }
        } }
      }
    }
  }

  // Invoked only by the consent sheet's affirmative action, never by import or activation.
  func submitPhotos(_ names: [String]) async {
    guard let client else { errorMessage = "请先在连接设置中填写本机地址和配对口令。"; return }
    guard !names.isEmpty, names.count <= 10, Set(names).count == names.count,
      names.allSatisfy({ StudyPersistence.isSafePhotoName($0) && state.importedPhotos.contains($0) }) else {
        errorMessage = "每次最多选择 10 张本机照片。请重新核对本次照片后再上传，没有发送任何照片。"
        return
      }
    // Task 4：每批提交前强制重新 health 检查（不是仅 30 秒缓存）；ready 才上传。
    guard await canSubmitNow() else {
      errorMessage = connectionState == .busy
        ? "识别服务当前繁忙，请稍后再试。照片仍保存在本机。"
        : "连接检查未通过，请检查网络或重新配对。照片仍保存在本机。"
      return
    }
    for name in names {
      guard change({ state in
        if let index = state.recognitionTasks.firstIndex(where: { $0.photoName == name }) {
          state.recognitionTasks[index].consentedAt = Date()
          // Task 4 review R2：归属随任务持久化（云端提交 = 归属当前服务），重启后仍可自动刷新。
          if pairing?.isCloud == true { state.recognitionTasks[index].ownedServiceId = pairing?.serviceId }
        } else {
          state.recognitionTasks.append(LocalRecognitionTask(id: UUID(), photoName: name,
            uploadName: name, consentedAt: Date(),
            ownedServiceId: pairing?.isCloud == true ? pairing?.serviceId : nil))
        }
      }), let task = state.recognitionTasks.first(where: { $0.photoName == name }), task.job == nil,
        !busyTasks.contains(task.id) else { continue }
      busyTasks.insert(task.id)
      uploadProgress[task.id] = 0
      client.uploadProgressHandler = { [weak self] fraction in
        Task { @MainActor [weak self] in self?.uploadProgress[task.id] = fraction }
      }
      do {
        let job = try await client.upload(file: photoURL(task.uploadName), idempotencyKey: task.id, photoName: name)
        _ = change { try $0.ingest(job, photoName: name) }
        // T6b：上传成功拿到任务后立即登记进 /v2 学习闭环；失败不影响上传结果，
        // 不弹错误，refreshJobs 会补登记（404 记 false 后不再重试）。
        await registerV2(jobID: job.id, taskID: task.id)
      } catch {
        change { state in
          if let index = state.recognitionTasks.firstIndex(where: { $0.id == task.id }) {
            state.recognitionTasks[index].lastError = error.localizedDescription
          }
        }
      }
      uploadProgress.removeValue(forKey: task.id)
      client.uploadProgressHandler = nil
      busyTasks.remove(task.id)
    }
    resumePolling()
  }

  /// T6k：按失败方案重试（PhotoFailurePlan）。找题目失败且可恢复 → 整张重试
  /// （questionId=null，服务器只在这时接受）；否则对每道「失败且可恢复」的题依次单题重试，
  /// 任一请求失败就停下并给出错误，已成功的保留。进行中重复调用直接返回。
  func retryFailed(taskID: UUID) async {
    guard let client, let task = state.recognitionTasks.first(where: { $0.id == taskID }),
      let job = task.job, !busyTasks.contains(taskID),
      let plan = PhotoFailurePlan.plan(for: task), plan.retryTitle != nil else { return }
    busyTasks.insert(taskID)
    defer { busyTasks.remove(taskID) }
    if plan.retryWholePhoto {
      do {
        let updated = try await client.retry(job.id, questionID: nil)
        if change({ try $0.ingest(updated, photoName: task.photoName) }) {
          try await cacheMedia(updated, client: client)
        }
      } catch { errorMessage = error.localizedDescription }
      return
    }
    for questionID in plan.retryQuestionIDs ?? [] {
      do {
        let updated = try await client.retry(job.id, questionID: questionID)
        if change({ try $0.ingest(updated, photoName: task.photoName) }) {
          try await cacheMedia(updated, client: client)
        }
      } catch { errorMessage = error.localizedDescription; return }
    }
  }

  /// T6k：把这张照片从「照片进度」里移除。只是不再显示：本机照片文件、识别任务、
  /// 已进错题本的题都不动；部分失败的「不管了 / 知道了」同样走这里。
  func dismissPhoto(_ name: String) {
    _ = change { state in
      if let index = state.recognitionTasks.firstIndex(where: { $0.photoName == name }) {
        state.recognitionTasks[index].dismissedFromProgress = true
      }
    }
  }

  // MARK: - S2：学生勾题

  /// 勾出错题：调用 select，成功后用返回的任务更新本机、置 pickDone、恢复轮询。
  /// 进行中重复调用直接返回 false；失败时给出学生能看懂的一句（409 还在找题 / 429 队列满 / 离线沿用现有提示）。
  @discardableResult
  func selectQuestions(taskID: UUID, questionIDs: [String]) async -> Bool {
    guard let client, let task = state.recognitionTasks.first(where: { $0.id == taskID }),
      let job = task.job, !questionIDs.isEmpty, !busyTasks.contains(taskID) else { return false }
    busyTasks.insert(taskID)
    defer { busyTasks.remove(taskID) }
    do {
      let updated = try await client.select(job.id, questionIDs: questionIDs)
      if change({ state in
        try state.ingest(updated, photoName: task.photoName)
        if let index = state.recognitionTasks.firstIndex(where: { $0.id == taskID }) {
          state.recognitionTasks[index].pickDone = true
        }
      }) {
        try await cacheMedia(updated, client: client)
      }
      resumePolling()
      return true
    } catch {
      if case RecognitionClientError.server(let status, _) = error, status == 409 {
        errorMessage = "这张照片还在找题，稍后再选"
      } else if case RecognitionClientError.server(let status, _) = error, status == 429 {
        errorMessage = "排队的题太多了，过一会儿再选"
      } else {
        errorMessage = error.localizedDescription
      }
      return false
    }
  }

  /// 「这页没有错题」：只置标记，不发请求。
  func markPickDone(_ name: String) {
    _ = change { state in
      if let index = state.recognitionTasks.firstIndex(where: { $0.photoName == name }) {
        state.recognitionTasks[index].pickDone = true
      }
    }
  }

  /// 候选题缩略裁图（勾选面板用）。取不到返回 nil，不弹错误；只在面板内存里，不落盘。
  func candidateImage(taskID: UUID, questionID: String) async -> Data? {
    guard let client, let jobID = state.recognitionTasks.first(where: { $0.id == taskID })?.job?.id
    else { return nil }
    return try? await client.candidateImage(jobID, questionID: questionID)
  }

  func mediaURL(jobID: String, mediaID: String) -> URL {
    persistence.directory.appendingPathComponent("Media/\(jobID)/\(mediaID).jpg")
  }

  /// T6b：登记进 /v2 学习闭环（docs/mobile-v2-api.md §3.1）。幂等。
  /// 成功置 v2Registered = true；404（任务不存在）记 false 并保留、不再重试；
  /// 其余失败保持 nil 静默留待 refreshJobs 补登记——登记失败绝不影响上传结果、不弹错误。
  /// T6c：返回登记结果，refreshJobs 的补登记循环遇到 .failed（非 404）即停止本轮。
  @discardableResult
  private func registerV2(jobID: String, taskID: UUID) async -> V2RegistrationOutcome {
    guard let v2Client else { return .failed }
    do {
      _ = try await v2Client.registerPhoto(jobId: jobID)
      _ = change { state in
        if let index = state.recognitionTasks.firstIndex(where: { $0.id == taskID }) {
          state.recognitionTasks[index].v2Registered = true
        }
      }
      return .registered
    } catch RecognitionClientError.server(status: 404, _) {
      _ = change { state in
        if let index = state.recognitionTasks.firstIndex(where: { $0.id == taskID }) {
          state.recognitionTasks[index].v2Registered = false
        }
      }
      return .notFound
    } catch {
      // 静默：上传已成功，登记留待下次 refreshJobs 补登记。
      return .failed
    }
  }

  /// 补登记单轮结果：成功 / 404（不再重试该任务，继续下一个）/ 失败（停止本轮）。
  private enum V2RegistrationOutcome { case registered, notFound, failed }

  private func cacheMedia(_ job: RecognitionJob, client: RecognitionClient) async throws {
    for question in job.questions {
      let ids = (question.questionMediaId.map { [$0] } ?? [])
        + (question.verification?.diagramSafe == true ? question.diagramMediaIds : [])
      for id in ids {
        guard !Task.isCancelled else { return }
        let url = mediaURL(jobID: job.id, mediaID: id)
        if await MediaReadability.readableFile(url) { readableMedia.insert(url); continue }
        readableMedia.remove(url)
        let data = try await client.media(job.id, mediaID: id)
        let directory = persistence.directory
        try await Task.detached {
          guard MediaReadability.isReadableJPEG(data) else {
            try MediaReadability.preserve(data, in: directory, mediaID: id)
            throw RecognitionClientError.missingMedia
          }
          if let previous = try? Data(contentsOf: url), !MediaReadability.isReadableJPEG(previous) {
            // Copy evidence successfully before atomically replacing the unusable cache entry.
            try MediaReadability.preserve(previous, in: directory, mediaID: id)
          }
          try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
          try StudyPersistence.excludeFromBackup(url)
        }.value
        readableMedia.insert(url)
        mediaRevision += 1
      }
    }
  }

  private func validateSavedMedia() async {
    for job in state.recognitionTasks.compactMap(\.job) {
      for id in job.questions.flatMap({ $0.diagramMediaIds }) {
        let url = mediaURL(jobID: job.id, mediaID: id)
        if await MediaReadability.readableFile(url) { readableMedia.insert(url) }
        else { readableMedia.remove(url) }
      }
    }
  }

  #if canImport(UIKit)
  func importPhoto(_ data: Data) async {
    guard !cannotLoad else { return }
    let id = UUID().uuidString
    let name = id + ".jpg"
    let directory = photoDirectory
    do {
      try await Task.detached {
        guard data.count <= 50_000_000, let image = UIImage(data: data),
          image.size.width * image.scale * image.size.height * image.scale <= 40_000_000,
          let jpeg = image.jpegData(compressionQuality: 0.9), jpeg.count <= 15_000_000
        else { throw RecognitionClientError.service("请使用小于 4000 万像素的照片，转换后的 JPEG 需小于 15 MB。") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try StudyPersistence.excludeFromBackup(directory)
        // Untouched original is independent of the one-time, immutable upload JPEG.
        try data.write(to: directory.appendingPathComponent(id + ".source"), options: .atomic)
        try jpeg.write(to: directory.appendingPathComponent(name), options: .atomic)
      }.value
      change { $0.importedPhotos.append(name) }
    } catch {
      errorMessage = "照片未能添加。\(error.localizedDescription)"
    }
  }
  #endif
}
