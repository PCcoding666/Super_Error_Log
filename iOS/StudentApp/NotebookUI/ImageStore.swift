import SwiftUI
import UIKit
import ImageIO

/// 服务器图片（缩略图、裁图、整页照片）的内存缓存。图片接口要 Bearer 令牌，AsyncImage 带不了，所以自己取；
/// 解码放在后台线程，并按显示尺寸降采样，几十张缩略图不会撑爆内存。
@MainActor
final class ImageStore {
  private let api: any WebAPI
  private let cache = NSCache<NSString, UIImage>()
  private var inflight: [String: Task<UIImage?, Never>] = [:]

  init(api: any WebAPI) {
    self.api = api
    cache.countLimit = 200
  }

  func image(for path: String, maxPixel: Int) async -> UIImage? {
    let key = "\(maxPixel)|\(path)" as NSString
    if let hit = cache.object(forKey: key) { return hit }
    if let running = inflight[key as String] { return await running.value }
    let api = self.api
    let task = Task<UIImage?, Never> {
      guard let data = try? await api.imageData(serverPath: path) else { return nil }
      return await Task.detached(priority: .userInitiated) { Self.decode(data, maxPixel: maxPixel) }.value
    }
    inflight[key as String] = task
    let image = await task.value
    inflight[key as String] = nil
    if let image { cache.setObject(image, forKey: key) }
    return image
  }

  nonisolated private static func decode(_ data: Data, maxPixel: Int) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
  }
}

extension EnvironmentValues {
  @Entry var imageStore: ImageStore? = nil
}

/// 服务器路径（`/s/img/…`）对应的图片：加载中是浅灰块，失败是图标。
struct RemoteImage: View {
  let path: String
  var maxPixel = 900
  var contentMode: ContentMode = .fit
  /// 加载前后占位的宽高比（宽/高）。
  var placeholderRatio: CGFloat = 4.0 / 3.0

  @Environment(\.imageStore) private var store
  @State private var image: UIImage?
  @State private var failed = false

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
      } else {
        Rectangle().fill(Color(.tertiarySystemFill)).aspectRatio(placeholderRatio, contentMode: .fit)
          .overlay {
            if failed { Image(systemName: "photo").foregroundStyle(.secondary) } else { ProgressView() }
          }
      }
    }
    .task(id: path) {
      image = nil
      failed = false
      let loaded = await store?.image(for: path, maxPixel: maxPixel)
      if let loaded { image = loaded } else if !Task.isCancelled { failed = true }
    }
  }
}

/// 全屏查看大图：双指缩放、双击放大、拖动；左上角返回。
struct PhotoViewer: View {
  let title: String
  let path: String
  @Environment(\.dismiss) private var dismiss
  @Environment(\.imageStore) private var store
  @State private var image: UIImage?
  @State private var failed = false

  var body: some View {
    NavigationStack {
      Group {
        if let image { ZoomableImage(image: image).ignoresSafeArea(edges: .bottom) }
        else if failed { ContentUnavailableView("图片打不开", systemImage: "photo", description: Text("检查网络后再试。")) }
        else { ProgressView().controlSize(.large) }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black.opacity(image == nil ? 0 : 1).ignoresSafeArea())
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { dismiss() } label: { Image(systemName: "chevron.backward") }
            .accessibilityLabel("返回").accessibilityIdentifier("photo-back")
        }
      }
      .toolbarColorScheme(image == nil ? nil : .dark, for: .navigationBar)
    }
    .task {
      let loaded = await store?.image(for: path, maxPixel: 3000)
      if let loaded { image = loaded } else { failed = true }
    }
    .accessibilityIdentifier("photo-viewer")
  }
}

private struct ZoomableImage: UIViewRepresentable {
  let image: UIImage

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UIScrollView {
    let scroll = UIScrollView()
    scroll.delegate = context.coordinator
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = 5
    scroll.showsHorizontalScrollIndicator = false
    scroll.showsVerticalScrollIndicator = false
    scroll.contentInsetAdjustmentBehavior = .never
    let view = UIImageView(image: image)
    view.contentMode = .scaleAspectFit
    view.isUserInteractionEnabled = true
    scroll.addSubview(view)
    context.coordinator.imageView = view
    let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
    double.numberOfTapsRequired = 2
    scroll.addGestureRecognizer(double)
    return scroll
  }

  func updateUIView(_ scroll: UIScrollView, context: Context) {
    guard let view = context.coordinator.imageView else { return }
    if view.image !== image { view.image = image; scroll.zoomScale = 1 }
    if view.frame.size != scroll.bounds.size {
      scroll.zoomScale = 1
      view.frame = CGRect(origin: .zero, size: scroll.bounds.size)
      scroll.contentSize = scroll.bounds.size
    }
  }

  final class Coordinator: NSObject, UIScrollViewDelegate {
    var imageView: UIImageView?
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
      guard let view = imageView else { return }
      let offsetX = max((scrollView.bounds.width - scrollView.contentSize.width) / 2, 0)
      let offsetY = max((scrollView.bounds.height - scrollView.contentSize.height) / 2, 0)
      view.center = CGPoint(x: scrollView.contentSize.width / 2 + offsetX, y: scrollView.contentSize.height / 2 + offsetY)
    }
    @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
      guard let scroll = gesture.view as? UIScrollView else { return }
      if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
      else {
        let point = gesture.location(in: imageView)
        let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
        scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
      }
    }
  }
}
