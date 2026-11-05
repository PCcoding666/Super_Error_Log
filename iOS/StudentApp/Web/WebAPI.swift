import Foundation

/// 视图模型依赖的网络面：生产里是 WebClient，测试里换成假的。
protocol WebAPI: Sendable {
  func notebook(_ query: NotebookQuery) async throws -> NotebookResponse
  func item(id: String) async throws -> ItemDetailResponse
  func discard(ids: [String]) async throws -> DiscardResponse
  func restore(id: String) async throws
  func category(id: String, grade: String, subject: String, chapter: String) async throws
  func settings() async throws -> SettingsResponse
  func setGrade(_ grade: String) async throws
  func intake() async throws -> IntakeResponse
  func uploadMode() async throws -> UploadModeResponse
  func select(photoID: String, ids: [String]) async throws
  func retry(photoID: String) async throws
  func dismiss(photoID: String) async throws
  func imageData(serverPath: String) async throws -> Data
  func uploadLegacy(key: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String
  func createMaterialsCapture(namespace: String, requestID: String) async throws -> String
  func uploadMaterials(namespace: String, captureID: String, uploadID: String, jpeg: Data,
    progress: @escaping @Sendable (Double) -> Void) async throws -> String
}

extension WebClient: WebAPI {}

/// 令牌被服务器撤销或过期（401）时通知会话回到登录页，其余错误原样抛给调用方。
struct GuardedAPI: WebAPI {
  let base: any WebAPI
  let onUnauthorized: @Sendable () -> Void

  private func guarded<T>(_ operation: () async throws -> T) async throws -> T {
    do { return try await operation() }
    catch let error as WebAPIError where error.isUnauthorized { onUnauthorized(); throw error }
  }

  func notebook(_ query: NotebookQuery) async throws -> NotebookResponse { try await guarded { try await base.notebook(query) } }
  func item(id: String) async throws -> ItemDetailResponse { try await guarded { try await base.item(id: id) } }
  func discard(ids: [String]) async throws -> DiscardResponse { try await guarded { try await base.discard(ids: ids) } }
  func restore(id: String) async throws { try await guarded { try await base.restore(id: id) } }
  func category(id: String, grade: String, subject: String, chapter: String) async throws {
    try await guarded { try await base.category(id: id, grade: grade, subject: subject, chapter: chapter) }
  }
  func settings() async throws -> SettingsResponse { try await guarded { try await base.settings() } }
  func setGrade(_ grade: String) async throws { try await guarded { try await base.setGrade(grade) } }
  func intake() async throws -> IntakeResponse { try await guarded { try await base.intake() } }
  func uploadMode() async throws -> UploadModeResponse { try await guarded { try await base.uploadMode() } }
  func select(photoID: String, ids: [String]) async throws { try await guarded { try await base.select(photoID: photoID, ids: ids) } }
  func retry(photoID: String) async throws { try await guarded { try await base.retry(photoID: photoID) } }
  func dismiss(photoID: String) async throws { try await guarded { try await base.dismiss(photoID: photoID) } }
  func imageData(serverPath: String) async throws -> Data { try await guarded { try await base.imageData(serverPath: serverPath) } }
  func uploadLegacy(key: String, jpeg: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    try await base.uploadLegacy(key: key, jpeg: jpeg, progress: progress)
  }
  func createMaterialsCapture(namespace: String, requestID: String) async throws -> String {
    try await base.createMaterialsCapture(namespace: namespace, requestID: requestID)
  }
  func uploadMaterials(namespace: String, captureID: String, uploadID: String, jpeg: Data,
    progress: @escaping @Sendable (Double) -> Void) async throws -> String {
    try await base.uploadMaterials(namespace: namespace, captureID: captureID, uploadID: uploadID, jpeg: jpeg, progress: progress)
  }
}
