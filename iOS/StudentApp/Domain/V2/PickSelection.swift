import Foundation

// S2-R1：勾选面板的勾选状态（纯逻辑）。
// 输入匹配出的题随输入框内容整体重算（「1」变成「15」后第 1 题自动取消，不再只增不减）；
// 学生手点的勾上/取消单独记忆，不被后续输入冲掉。
struct PickSelection: Equatable, Sendable {
  /// 学生手点勾上的题。
  private(set) var manualOn: Set<String> = []
  /// 学生手点取消的题。
  private(set) var manualOff: Set<String> = []

  /// 当前勾选的题 =（当前输入匹配的题 ∪ 手点勾上）− 手点取消。
  func checked(inputIDs: Set<String>) -> Set<String> {
    inputIDs.union(manualOn).subtracting(manualOff)
  }

  /// 手点一题：已勾 → 记为手点取消；未勾 → 记为手点勾上。
  mutating func toggle(_ id: String, inputIDs: Set<String>) {
    if checked(inputIDs: inputIDs).contains(id) {
      manualOn.remove(id)
      manualOff.insert(id)
    } else {
      manualOff.remove(id)
      manualOn.insert(id)
    }
  }
}
