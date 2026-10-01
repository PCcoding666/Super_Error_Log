import Foundation
import CoreGraphics

// T6c-R2：题目详情页整题裁图的显示高度。整题裁图通常是很宽的一条，固定 420pt 会
// 上下留出大片空白；改为按宽高比等比折算（可用宽度 × 图片高 ÷ 图片宽），
// 并夹在 [minHeight, maxHeight] 之间。
enum CropDisplayHeight {
  static let minHeight: CGFloat = 80
  static let maxHeight: CGFloat = 420

  /// 给定图片宽高与可用宽度 → 显示高度。输入非法（零或负值）时退回最小高度，避免除零与负高度。
  static func displayHeight(imageWidth: CGFloat, imageHeight: CGFloat, availableWidth: CGFloat) -> CGFloat {
    guard imageWidth > 0, imageHeight > 0, availableWidth > 0 else { return minHeight }
    let raw = availableWidth * imageHeight / imageWidth
    return min(maxHeight, max(minHeight, raw))
  }
}
