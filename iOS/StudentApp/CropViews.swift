import SwiftUI
import UIKit

// T6g：整题裁图相关共用视图。
// - CropThumbnail：合并了主页 CropThumbnail 与录结果页 ReturnCropThumbnail 两份重复实现，
//   题干小图（scope 缺省）经 LoopStore 带令牌取字节、本地缓存，不走 AsyncImage 直连服务器。
// - FullCropImage：详情页 / 修改面板 / 追问页共用的可缩放整题大图。优先取 scope=full
//   整题大图；取不到（旧服务器 400/404、离线）退回题干小图，不显示错误。

/// 题干裁图缩略图。卡片/行里由调用方给 frame 与 clipped；fill 为 true 时铺满裁边（窄行用），
/// 否则等比完整显示（主页宽卡片用）。
struct CropThumbnail: View {
  let itemID: String
  var fill = false
  @Environment(LoopStore.self) private var store
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image {
        if fill {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          Image(uiImage: image).resizable().scaledToFit()
        }
      } else {
        Image(systemName: "photo").foregroundStyle(Palette.muted)
      }
    }
    .task(id: itemID) {
      guard let url = await store.cropFileURL(itemID: itemID) else { return }
      image = await Task.detached { UIImage(contentsOfFile: url.path) }.value
    }
  }
}

/// 可缩放整题大图：高度按宽高比折算（CropDisplayHeight），上限由调用方给
/// （详情页缺省 420pt，修改面板 260pt，追问页 200pt）。图片未取到时不占位。
struct FullCropImage: View {
  let itemID: String
  var maxHeight: CGFloat = CropDisplayHeight.maxHeight
  /// 图片载入后显示在图下的说明文字（如「整题裁图 · 双指缩放」）；nil 不显示。
  var caption: String? = nil
  @Environment(LoopStore.self) private var store
  @State private var image: UIImage?
  /// 裁图区可用宽度（由 onGeometryChange 测得，未测到时为 0，高度退回下限）。
  @State private var availableWidth: CGFloat = 0

  var body: some View {
    Group {
      if let image {
        VStack(alignment: .leading, spacing: 16) {
          ZoomablePhoto(image: image, role: .crop)
            .frame(maxWidth: .infinity)
            .frame(height: CropDisplayHeight.displayHeight(imageWidth: image.size.width,
              imageHeight: image.size.height, availableWidth: availableWidth, maxHeight: maxHeight))
          if let caption {
            Text(caption).font(.caption).foregroundStyle(Palette.muted)
          }
        }
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
    .task(id: itemID) {
      // 整题大图取不到（旧服务器 400/404、离线）退回题干小图，不显示错误。
      var url = await store.cropFileURL(itemID: itemID, scope: .full)
      if url == nil { url = await store.cropFileURL(itemID: itemID) }
      guard let url else { return }
      image = await Task.detached { UIImage(contentsOfFile: url.path) }.value
    }
  }
}
