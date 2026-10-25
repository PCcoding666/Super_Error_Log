import Foundation
import Observation

/// 录入态：一次上传算一个批次，按照片分段；找到的题默认已在错题本，左滑删掉不相关的；
/// 没批改痕迹的页勾出做错的题。对照 client/src/pages/IntakePage.tsx。
@MainActor @Observable
final class IntakeModel {
  private let api: any WebAPI
  let uploads: UploadQueue
  private(set) var data: IntakeResponse?
  private(set) var error: WebAPIError?
  var toast: String?
  /// 没有批改痕迹的页：每张照片里被勾上的候选题。
  var picked: [String: Set<String>] = [:]
  private var polling: Task<Void, Never>?

  init(api: any WebAPI, uploads: UploadQueue) {
    self.api = api
    self.uploads = uploads
  }

  func reload() async {
    do {
      let fresh = try await api.intake()
      data = fresh
      error = nil
      uploads.setMode(fresh.uploadMode)
    } catch is CancellationError {
      return
    } catch {
      self.error = (error as? WebAPIError) ?? .unreachable
    }
  }

  /// 还在找题、还在上传、或刚传完还没登记：要继续轮询。
  var busy: Bool {
    if data?.busy == true || uploads.busy { return true }
    let known = Set((data?.photos ?? []).map(\.id))
    return uploads.entries.contains { $0.state == .succeeded && !known.contains($0.photoID ?? "") }
  }

  /// 前台每 3 秒取一次，只换数据不整页刷新；离开页面时停。
  func startPolling() {
    guard polling == nil else { return }
    polling = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        guard let self, !Task.isCancelled else { return }
        if self.busy { await self.reload() }
      }
    }
  }

  func stopPolling() { polling?.cancel(); polling = nil }

  // MARK: - 分段

  private var uploadedIDs: Set<String> { Set(uploads.batchIDs) }
  private var batchSize: Int { uploadedIDs.count + uploads.entries.filter { $0.photoID == nil }.count }
  private var photos: [IntakePhoto] { data?.photos ?? [] }

  /// 本批上传的照片在前（按拍摄先后，和学生选照片的顺序一致）；没有本批时只展开最近一张。
  var current: [IntakePhoto] {
    let chosen = batchSize > 0 ? photos.filter { uploadedIDs.contains($0.id) } : Array(photos.prefix(1))
    return chosen.sorted {
      let a = $0.takenDate ?? .distantPast, b = $1.takenDate ?? .distantPast
      return a == b ? $0.number < $1.number : a < b
    }
  }

  var earlier: [IntakePhoto] {
    let ids = Set(current.map(\.id))
    return photos.filter { !ids.contains($0.id) }
  }

  var found: Int { current.reduce(0) { $0 + $1.questions.count } }

  var status: String {
    let pending = uploads.pendingEntries
    if !pending.isEmpty { return "正在上传 · 还剩 \(pending.filter { $0.state != .failed }.count) 张" }
    if busy { return "AI 正在找题" }
    if found > 0 { return "找到 \(found) 道，已加入错题本 · 不相关的左滑删掉" }
    if !current.isEmpty { return "这一批没有新增错题" }
    return "还没有录入"
  }

  // MARK: - 操作

  func remove(itemID: String) async {
    do {
      let result = try await api.discard(ids: [itemID])
      if let failure = result.failed.first { toast = failure.message }
    } catch { toast = (error as? WebAPIError)?.message ?? "没有移除" }
    await reload()
  }

  func togglePick(photoID: String, candidateID: String) {
    var set = picked[photoID] ?? []
    if set.contains(candidateID) { set.remove(candidateID) } else { set.insert(candidateID) }
    picked[photoID] = set
  }

  func include(_ photo: IntakePhoto) async {
    let ids = Array(picked[photo.id] ?? [])
    guard !ids.isEmpty else { return }
    do { try await api.select(photoID: photo.id, ids: ids); picked[photo.id] = [] }
    catch { toast = (error as? WebAPIError)?.message ?? "没加进去" }
    await reload()
  }

  func retry(_ photo: IntakePhoto) async {
    do { try await api.retry(photoID: photo.id) }
    catch { toast = (error as? WebAPIError)?.message ?? "没重试成功" }
    await reload()
  }

  func dismiss(_ photo: IntakePhoto) async {
    try? await api.dismiss(photoID: photo.id)
    await reload()
  }
}
