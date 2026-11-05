import Foundation
import Observation

/// 题目详情：照片、题干、你写的、章节与知识点；改分类、移除。对照 client/src/pages/ItemPage.tsx。
@MainActor @Observable
final class ItemModel {
  struct CategoryDraft: Equatable {
    var grade: String
    var subject: String
    var chapter: String
  }

  let itemID: String
  private let api: any WebAPI
  private(set) var detail: ItemDetailResponse?
  private(set) var error: WebAPIError?
  var toast: String?

  init(itemID: String, api: any WebAPI) {
    self.itemID = itemID
    self.api = api
  }

  func reload() async {
    do { detail = try await api.item(id: itemID); error = nil }
    catch is CancellationError { return }
    catch { self.error = (error as? WebAPIError) ?? .unreachable }
  }

  var draft: CategoryDraft? {
    detail.map { CategoryDraft(grade: $0.category.grade, subject: $0.category.subject, chapter: $0.category.chapter) }
  }

  /// 正在编辑的「学段 × 学科」对应的章节候选。
  func chapters(for draft: CategoryDraft) -> [String] {
    detail?.category.chapters(grade: draft.grade, subject: draft.subject) ?? []
  }

  /// 换了学段或学科，原来填的章节若不在新候选里就清空，免得把数学章节存成物理的。
  func retarget(_ draft: CategoryDraft, grade: String? = nil, subject: String? = nil) -> CategoryDraft {
    var next = draft
    if let grade { next.grade = grade }
    if let subject { next.subject = subject }
    if !chapters(for: next).contains(next.chapter) { next.chapter = "" }
    return next
  }

  func save(_ draft: CategoryDraft) async -> Bool {
    do {
      try await api.category(id: itemID, grade: draft.grade, subject: draft.subject, chapter: draft.chapter)
      toast = "分类已更新"
      await reload()
      return true
    } catch {
      toast = (error as? WebAPIError)?.message ?? "没保存成功"
      return false
    }
  }

  func discard() async -> Bool {
    do { _ = try await api.discard(ids: [itemID]); return true }
    catch { toast = (error as? WebAPIError)?.message ?? "没有移除"; return false }
  }
}
