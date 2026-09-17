import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif
import ImageIO

@MainActor @Observable
final class StudyStore {
  private(set) var state = StudyState()
  private(set) var cannotLoad = false
  var errorMessage: String?
  let persistence: StudyPersistence
  private(set) var pairing: PairingConfiguration?
  private(set) var busyTasks: Set<UUID> = []
  private(set) var syncing = false
  private(set) var mediaRevision = 0
  private(set) var readableMedia: Set<URL> = []
  // Task 4: 连接状态机（云端模式；回环模式保持 nil，由既有 UI 表达）。
  private(set) var connectionState: ConnectionState?
  private var connectionTracker = ConnectionTracker()
  private var connectionGeneration = 0
  private var lastConnectionCheck: Date?
  private var connectionCheckInFlight: Task<Void, Never>?
  private var isActive = false
  private var client: RecognitionClient?
  private var polling: Task<Void, Never>?

  init(persistence suppliedPersistence: StudyPersistence? = nil, client suppliedClient: RecognitionClient? = nil) {
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
    if let suppliedClient { client = suppliedClient; pairing = suppliedClient.configuration }
    else { loadPairing() }
  }

  var completedCount: Int { state.realProblems.filter { state.drafts[$0.id]?.submittedAt != nil }.count }
  var hasDraft: Bool { state.drafts.values.contains { $0.submittedAt == nil } }
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

  func updateDraft(_ id: String, _ draft: ReflectionDraft) -> Bool {
    change { $0.updateDraft(id, draft: draft) }
  }

  func submit(_ id: String, draft: ReflectionDraft) -> Bool {
    change { try $0.submit(id, draft: draft) }
  }

  func select(_ id: String) {
    change { try $0.select(id, selected: !$0.selectedIDs.contains(id)) }
  }

  func photoURL(_ name: String) -> URL { photoDirectory.appendingPathComponent(name) }

  func originalURL(_ name: String) -> URL {
    let original = photoDirectory.appendingPathComponent(String(name.dropLast(4)) + ".source")
    return FileManager.default.fileExists(atPath: original.path) ? original : photoURL(name)
  }

  func sourceURL(_ problem: StudyProblem) -> URL? {
    if let path = problem.sourceImagePath { return persistence.directory.appendingPathComponent(path) }
    return Bundle.main.url(forResource: problem.source, withExtension: "jpg")
  }

  func diagramURL(_ problem: StudyProblem, index: Int) -> URL? {
    guard problem.hasValidSnapshot, problem.diagramPaths.indices.contains(index) else { return nil }
    let url = persistence.directory.appendingPathComponent(problem.diagramPaths[index])
    let root = persistence.directory.resolvingSymlinksInPath().standardizedFileURL.path + "/"
    return url.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(root) ? url : nil
  }

  func loadPairing() {
    do {
      #if DEBUG
      try PairingStore.consumeBootstrap(in: persistence.directory)
      #endif
      pairing = try PairingStore.load(scope: persistence.directory.lastPathComponent)
      client?.close()
      client = pairing.map { RecognitionClient(configuration: $0) }
      if pairing?.isCloud == true {
        connectionTracker = ConnectionTracker()
        connectionGeneration = connectionTracker.paired()
        connectionState = .pairedNeedsCheck
      } else { connectionState = nil }
    } catch { errorMessage = "无法读取配对信息，请在连接设置中重新输入。" }
  }

  /// 云端配对落库（扫码兑换成功后调用）。同 service 重配触发代次 +1，迟到旧响应按代次丢弃。
  func adoptCloudPairing(_ configuration: PairingConfiguration) {
    client?.close()
    client = RecognitionClient(configuration: configuration)
    pairing = configuration
    connectionTracker = ConnectionTracker()
    connectionGeneration = connectionTracker.paired()
    connectionState = .pairedNeedsCheck
    resumePolling()
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
        if change({ try $0.ingest(updated, photoName: task.photoName) }) {
          try await cacheMedia(updated, client: client)
        }
      } catch {
        if !Task.isCancelled { change { state in
          if let index = state.recognitionTasks.firstIndex(where: { $0.id == task.id }) {
            state.recognitionTasks[index].lastError = error.localizedDescription
          }
        } }
      }
    }
  }

  // Explicit read-only collection sync: never submits photos or grants upload consent.
  // 云端模式下仅读取归属当前服务的任务（由本次会话提交）；旧来源任务不自动向新服务查询。
  func syncExistingJobs() async {
    guard let client, !cannotLoad, !syncing else {
      if client == nil { errorMessage = "请先填写本机连接设置。" }
      return
    }
    syncing = true
    defer { syncing = false }
    do {
      let jobs = try await client.listJobs()
      for job in jobs {
        // 归属校验（云端）：serviceId 无法从 job 自身获得，以「随任务持久化的归属」为边界——
        // 只更新归属当前服务或回环导入的本地条目；归属其他服务的任务既不新增也不查询。
        if pairing?.isCloud == true {
          let matched = state.recognitionTasks.contains { task in
            guard task.job?.id == job.id else { return false }
            return task.ownedServiceId == pairing?.serviceId || task.ownedServiceId == nil
          }
          if !matched { continue }
        }
        if let existing = state.recognitionTasks.first(where: { $0.job?.id == job.id }) {
          _ = change { try $0.ingest(job, photoName: existing.photoName) }
        } else if pairing?.isCloud != true {
          // 回环模式保留原有全量读取行为。
          let name = UUID().uuidString + ".jpg"
          let bytes = try await client.media(job.id, mediaID: job.sourceMediaId)
          let directory = photoDirectory
          try await Task.detached {
            guard MediaReadability.isReadableJPEG(bytes) else { throw RecognitionClientError.invalidResponse }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try StudyPersistence.excludeFromBackup(directory)
            try bytes.write(to: directory.appendingPathComponent(name), options: .atomic)
            try bytes.write(to: directory.appendingPathComponent(String(name.dropLast(4)) + ".source"), options: .atomic)
          }.value
          guard change({ state in
            if !state.recognitionTasks.contains(where: { $0.job?.id == job.id }) { state.importedPhotos.append(name) }
            try state.ingest(job, photoName: name)
          }) else { return }
        }
        let current = state.recognitionTasks.first { $0.job?.id == job.id }?.job ?? job
        try await cacheMedia(current, client: client)
      }
    } catch { errorMessage = error.localizedDescription }
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
      do {
        let job = try await client.upload(file: photoURL(task.uploadName), idempotencyKey: task.id, photoName: name)
        _ = change { try $0.ingest(job, photoName: name) }
      } catch {
        change { state in
          if let index = state.recognitionTasks.firstIndex(where: { $0.id == task.id }) {
            state.recognitionTasks[index].lastError = error.localizedDescription
          }
        }
      }
      busyTasks.remove(task.id)
    }
    resumePolling()
  }

  func act(taskID: UUID, questionID: String?, skip: Bool = false, sourceCompared: Bool = false, retry: Bool = false) async {
    guard let client, let task = state.recognitionTasks.first(where: { $0.id == taskID }),
      let job = task.job, !busyTasks.contains(taskID) else { return }
    busyTasks.insert(taskID)
    defer { busyTasks.remove(taskID) }
    do {
      let updated: RecognitionJob
      if retry { updated = try await client.retry(job.id, questionID: questionID) }
      else if let question = job.questions.first(where: { $0.id == questionID }) {
        if !skip {
          await validateSavedMedia()
          guard hasCachedDiagrams(job: job, question: question) else { throw RecognitionClientError.missingMedia }
        }
        updated = try await client.confirm(job.id, question: question, skip: skip, sourceCompared: sourceCompared)
      } else { return }
      if change({ try $0.ingest(updated, photoName: task.photoName) }) {
        try await cacheMedia(updated, client: client)
      }
    } catch { errorMessage = error.localizedDescription }
  }

  func mediaURL(jobID: String, mediaID: String) -> URL {
    persistence.directory.appendingPathComponent("Media/\(jobID)/\(mediaID).jpg")
  }

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

  func refreshMedia(_ job: RecognitionJob) async {
    guard let client else { return }
    do { try await cacheMedia(job, client: client) }
    catch { errorMessage = error.localizedDescription }
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

  func hasCachedDiagrams(job: RecognitionJob, question: RecognitionQuestion) -> Bool {
    question.diagramMediaIds.allSatisfy { readableMedia.contains(mediaURL(jobID: job.id, mediaID: $0)) }
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

  func createPack() -> PDFDocumentItem? {
    guard !cannotLoad else { return nil }
    do {
      var next = state
      let pack = try next.makePack()
      let url = try ReviewPDF.write(pack: pack, directory: persistence.directory)
      try persistence.save(next)
      state = next
      return PDFDocumentItem(url: url)
    } catch {
      errorMessage = "无法生成练习包。\(error.localizedDescription)"
      return nil
    }
  }

  func openPack(_ pack: PaperPack) -> PDFDocumentItem? {
    do {
      return PDFDocumentItem(url: try ReviewPDF.write(pack: pack, directory: persistence.directory))
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }
  #endif

  func recordOutcome(packID: UUID, problemID: String, outcome: String) -> Bool {
    change { state in
      guard ReflectionOptions.paperOutcomes.contains(outcome),
        let index = state.packs.firstIndex(where: { $0.id == packID }),
        state.packs[index].problemIDs.contains(problemID)
      else { throw StudyError.unknownProblem }
      state.packs[index].outcomes[problemID] = outcome
    }
  }
}
