import Foundation
import Observation

/// 设置：学段、账号、版本。对照 client/src/pages/SettingsPage.tsx。
@MainActor @Observable
final class SettingsModel {
  private let api: any WebAPI
  private(set) var data: SettingsResponse?
  private(set) var error: WebAPIError?
  var toast: String?

  init(api: any WebAPI) { self.api = api }

  func reload() async {
    do { data = try await api.settings(); error = nil }
    catch is CancellationError { return }
    catch { self.error = (error as? WebAPIError) ?? .unreachable }
  }

  func setGrade(_ grade: String) async {
    guard grade != data?.grade else { return }
    do { try await api.setGrade(grade); toast = "学段已更新" }
    catch { toast = (error as? WebAPIError)?.message ?? "没保存成功" }
    await reload()
  }
}
