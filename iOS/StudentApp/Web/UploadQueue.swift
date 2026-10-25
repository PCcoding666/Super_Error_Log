import Foundation
import Observation

/// 一张待传 / 在传 / 传完的照片。
struct UploadEntry: Identifiable, Equatable, Sendable {
  enum State: Equatable, Sendable { case queued, preparing, uploading, succeeded, failed }

  let id: String
  var name: String
  var state: State = .queued
  var progress: Double = 0
  var message = "等待上传"
  var retryable = false
  /// 列表里的小预览（JPEG 字节）。
  var preview: Data?
  /// 服务器返回的照片 id（旧流程 jobId / 材料流程 assetId）。
  var photoID: String?
  fileprivate var original: Data?
  fileprivate var prepared: Data?

  var isPending: Bool { photoID == nil }
}

/// 拍照上传队列（搬自网页版 client/src/lib/uploader.ts 的约定）：
/// - 准备和上传单并发，手机不同时持有多张大图；
/// - 每张照片一个幂等 key，重试用同一个 key 和同一份转换结果，服务器不会重复登记；
/// - 2xx 但响应不是约定形状不算成功；图片本身的问题不提供重试，其余失败可重试；
/// - 旧流程（/capture）和材料流程（/materials/*）由 `/api/upload` 的 mode 决定。
@MainActor @Observable
final class UploadQueue {
  private(set) var entries: [UploadEntry] = []
  /// 本批次传好的照片 id：录入页据此决定先展开哪几张。
  private(set) var batchIDs: [String] = []

  private var api: (any WebAPI)?
  private var batchClosed = false
  private var running = false
  private var mode: UploadMode?
  private var materialsCaptureID: String?
  private var materialsRequestID = UUID().uuidString

  var busy: Bool { entries.contains { [.queued, .preparing, .uploading].contains($0.state) } }
  var succeededCount: Int { entries.filter { $0.state == .succeeded }.count }
  var pendingEntries: [UploadEntry] { entries.filter(\.isPending) }

  /// 登录 / 退出时换接口；换账号后不能把上一个账号的批次带过来。
  func bind(api: (any WebAPI)?) {
    self.api = api
    entries = []
    batchIDs = []
    batchClosed = false
    mode = nil
    materialsCaptureID = nil
    materialsRequestID = UUID().uuidString
  }

  func setMode(_ newMode: UploadMode) {
    guard newMode != mode else { return }
    mode = newMode
    materialsCaptureID = nil
    materialsRequestID = UUID().uuidString
  }

  /// 点了「完成」：这一批结束，下次选照片开新的一批。
  func finishBatch() {
    batchClosed = true
    entries.removeAll { $0.state == .succeeded }
  }

  func add(_ photos: [Data]) {
    if batchClosed {
      batchClosed = false
      batchIDs = []
      entries.removeAll { !($0.state == .failed && $0.retryable) }
    }
    for (offset, data) in photos.enumerated() {
      var entry = UploadEntry(id: UUID().uuidString, name: "照片 \(entries.count + offset + 1)")
      entry.original = data
      entries.append(entry)
    }
    pump()
    // 小预览在后台生成，不拖慢选完照片后的界面。
    let ids = entries.suffix(photos.count).map(\.id)
    for (id, data) in zip(ids, photos) {
      Task.detached(priority: .utility) { [weak self] in
        let preview = ImagePreparer.preview(data)
        await MainActor.run { self?.update(id) { $0.preview = preview } }
      }
    }
  }

  func retry() {
    for index in entries.indices where entries[index].state == .failed && entries[index].retryable {
      entries[index].state = .queued
      entries[index].progress = 0
      entries[index].message = "等待上传"
    }
    pump()
  }

  // MARK: - 内部

  private func update(_ id: String, _ change: (inout UploadEntry) -> Void) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    change(&entries[index])
  }

  private func pump() {
    guard !running, entries.contains(where: { $0.state == .queued }) else { return }
    running = true
    Task { [weak self] in
      while let self, let next = self.entries.first(where: { $0.state == .queued }) {
        await self.process(next.id)
      }
      self?.running = false
    }
  }

  private func process(_ id: String) async {
    guard let entry = entries.first(where: { $0.id == id }) else { return }
    update(id) { $0.state = .preparing; $0.message = "正在准备照片…" }
    do {
      let prepared: Data
      if let existing = entry.prepared { prepared = existing }
      else {
        guard let original = entry.original else { throw UploadFailure.generic }
        prepared = try await Self.prepare(original)
        update(id) { $0.prepared = prepared }
      }
      update(id) { $0.state = .uploading; $0.progress = 0; $0.message = "正在上传…" }
      let photoID = try await send(id: id, jpeg: prepared)
      update(id) {
        $0.photoID = photoID; $0.state = .succeeded; $0.progress = 1
        $0.message = "已上传 · AI 正在找题"; $0.prepared = nil; $0.original = nil
      }
      if !batchIDs.contains(photoID) { batchIDs.append(photoID) }
    } catch {
      let failure = Self.failure(for: error)
      update(id) {
        $0.state = .failed; $0.progress = 0; $0.message = failure.message; $0.retryable = failure.retryable
        if !failure.retryable { $0.original = nil; $0.prepared = nil }
      }
    }
  }

  private static func failure(for error: Error) -> UploadFailure {
    if let failure = error as? UploadFailure { return failure }
    if let error = error as? WebAPIError {
      return UploadFailure(message: error.message, retryable: error.status == 0 || error.status >= 500 || error.status == 429)
    }
    switch error as? ImagePreparer.Failure {
    case .tooBig: return UploadFailure(message: "这张照片转出来还是太大，换一张试试。", retryable: false)
    case .encode: return UploadFailure(message: "照片转换没完成。点「再试一次」，或者换一张。", retryable: true)
    case .decode: return UploadFailure(message: "这张照片读不了。换一张试试。", retryable: false)
    case nil:
      if error is PrepareTimeout { return UploadFailure(message: "准备照片超时了。点「再试一次」，或者换一张。", retryable: true) }
      return .generic
    }
  }

  private struct PrepareTimeout: Error {}

  /// 转换在后台线程做，30 秒没完就放弃这一次（大图在老机器上可能很慢）。
  private static func prepare(_ original: Data) async throws -> Data {
    try await withThrowingTaskGroup(of: Data.self) { group in
      group.addTask { try await Task.detached(priority: .userInitiated) { try ImagePreparer.prepare(original) }.value }
      group.addTask { try await Task.sleep(for: .seconds(30)); throw PrepareTimeout() }
      defer { group.cancelAll() }
      return try await group.next()!
    }
  }

  private func send(id: String, jpeg: Data) async throws -> String {
    guard let api else { throw UploadFailure.generic }
    let progress: @Sendable (Double) -> Void = { [weak self] fraction in
      Task { @MainActor in
        self?.update(id) {
          $0.progress = fraction
          $0.message = fraction >= 1 ? "上传完成，正在处理照片…" : "正在上传 \(Int((fraction * 100).rounded()))%"
        }
      }
    }
    let resolved = try await resolveMode(api: api)
    switch resolved {
    case .legacy:
      return try await api.uploadLegacy(key: id, jpeg: jpeg, progress: progress)
    case .materials(let namespace):
      if materialsCaptureID == nil {
        materialsCaptureID = try await api.createMaterialsCapture(namespace: namespace, requestID: materialsRequestID)
      }
      return try await api.uploadMaterials(namespace: namespace, captureID: materialsCaptureID!, uploadID: id, jpeg: jpeg, progress: progress)
    }
  }

  /// 首次上传前向服务器确认该走哪套端点（材料流程不接受旧端点）；网络失败按可重试处理，照片留在队列里。
  private func resolveMode(api: any WebAPI) async throws -> UploadMode {
    if let mode { return mode }
    do {
      let resolved = try await api.uploadMode().uploadMode
      setMode(resolved)
      return resolved
    } catch let error as WebAPIError {
      throw UploadFailure(message: error.status == 0 ? UploadFailure.network.message : error.message, retryable: error.status != 400)
    }
  }
}
