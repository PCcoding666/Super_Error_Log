import Foundation
import Observation

/// 错题本首页：筛选、选择、移除与撤销。逻辑对照 client/src/pages/HomePage.tsx。
@MainActor @Observable
final class NotebookModel {
  struct Toast: Equatable, Identifiable {
    let id = UUID()
    let message: String
    /// 可撤销的题目 id（移除成功时给出）。
    var undo: [String]?
  }

  private let api: any WebAPI
  var query = NotebookQuery()
  private(set) var response: NotebookResponse?
  private(set) var error: WebAPIError?
  private(set) var isLoading = false
  var selecting = false
  var selected: Set<String> = []
  var toast: Toast?
  private var generation = 0

  init(api: any WebAPI) { self.api = api }

  var stageRequired: Bool { error?.isStageRequired == true }
  /// 其他错误（学段门槛由单独页面处理）。
  var problem: WebAPIError? { stageRequired ? nil : error }
  var items: [NotebookItem] { response?.items ?? [] }

  var subtitle: String {
    guard let response else { return "" }
    var text = "\(response.grade) · \(response.total) 道错题"
    if response.shown != response.total { text += " · 显示 \(response.shown) 道" }
    return text
  }

  /// 取数据。多次触发时只认最后一次的结果，慢的旧响应不会盖掉新的筛选。
  func reload() async {
    generation += 1
    let mine = generation
    isLoading = true
    defer { if mine == generation { isLoading = false } }
    do {
      let fresh = try await api.notebook(query)
      guard mine == generation else { return }
      response = fresh
      error = nil
    } catch is CancellationError {
      return
    } catch {
      guard mine == generation else { return }
      self.error = (error as? WebAPIError) ?? .unreachable
    }
  }

  // 筛选：换学科 / 学段会清掉下面几级，和网页版一致。
  func setSubject(_ name: String) async { query = NotebookQuery(subject: name); await reload() }
  func setStage(_ name: String) async { query.grade = name; query.chapter = ""; query.tag = ""; await reload() }
  func setChapter(_ name: String) async { query.chapter = name; await reload() }
  func setTag(_ name: String) async { query.tag = name; await reload() }
  func setSearch(_ text: String) async { query.q = text; await reload() }
  func clearFilters() async { query.chapter = ""; query.tag = ""; query.q = ""; await reload() }

  /// 新账号第一次：选初中 / 高中。
  func chooseStage(_ grade: String) async -> String? {
    do { try await api.setGrade(grade); error = nil; await reload(); return nil }
    catch { return (error as? WebAPIError)?.message ?? WebAPIError.unreachable.message }
  }

  // MARK: - 选择与移除

  func toggle(_ id: String) {
    if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
  }

  func startSelecting() { selecting = true; selected = [] }
  func leaveSelecting() { selecting = false; selected = [] }

  func discard(_ ids: [String]) async {
    do {
      let result = try await api.discard(ids: ids)
      toast = Toast(message: result.removed.isEmpty ? (result.failed.first?.message ?? "没有移除") : "已移除 \(result.removed.count) 道",
        undo: result.removed.isEmpty ? nil : result.removed)
    } catch {
      toast = Toast(message: (error as? WebAPIError)?.message ?? "没有移除")
    }
    leaveSelecting()
    await reload()
  }

  func undo(_ ids: [String]) async {
    for id in ids { try? await api.restore(id: id) }
    toast = nil
    await reload()
  }
}
