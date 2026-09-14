import AVFoundation
import SwiftUI
import UIKit

struct PhotoReference: Identifiable {
  var id: URL { url }
  let url: URL
  let title: String
  var role: PhotoRole = .original
}

enum PhotoRole {
  case original, crop
  var label: String { self == .original ? "完整原图" : "裁剪区域（可能不完整）" }
  var identifier: String { self == .original ? "original-photo" : "crop-photo" }
}

struct SourcePhotoView: View {
  let reference: PhotoReference
  var onViewed: (() -> Void)? = nil
  @State private var image: UIImage?
  @State private var loading = true
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let image {
          ZoomablePhoto(image: image, role: reference.role).accessibilityIdentifier(reference.role.identifier)
          Text("\(reference.role.label) · 双指缩放").font(.caption).foregroundStyle(Palette.muted)
            .padding()
        } else if loading {
          ProgressView("正在打开\(reference.role.label)…")
        } else {
          ContentUnavailableView(
            "照片不可用", systemImage: "photo.badge.exclamationmark",
            description: Text(
              "无法打开\(reference.role.label)，这里不会显示替代图片。"))
        }
      }.background(Palette.paper).navigationTitle(reference.title).navigationBarTitleDisplayMode(
        .inline
      )
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
      .task(id: reference.url) {
        image = await Task.detached { UIImage(contentsOfFile: reference.url.path) }.value
        loading = false
        if image != nil { onViewed?() }
      }
    }
  }
}

struct ZoomablePhoto: UIViewRepresentable {
  let image: UIImage
  let role: PhotoRole
  func makeUIView(context: Context) -> PhotoScrollView { PhotoScrollView(image: image, role: role) }
  func updateUIView(_ uiView: PhotoScrollView, context: Context) {}
}

final class PhotoScrollView: UIScrollView, UIScrollViewDelegate {
  private let imageView: UIImageView
  private var lastSize: CGSize = .zero

  init(image: UIImage, role: PhotoRole) {
    imageView = UIImageView(image: image)
    super.init(frame: .zero)
    delegate = self
    addSubview(imageView)
    imageView.frame = CGRect(origin: .zero, size: image.size)
    imageView.isAccessibilityElement = true
    imageView.accessibilityLabel = role.label
    imageView.accessibilityIdentifier = role.identifier
    contentSize = image.size
    bouncesZoom = true
    backgroundColor = UIColor(Palette.paper)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != lastSize, bounds.width > 0, bounds.height > 0, let image = imageView.image
    else { return }
    lastSize = bounds.size
    let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
    minimumZoomScale = fit
    maximumZoomScale = max(fit * 8, 1)
    zoomScale = fit
    centerPhoto()
  }
  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centerPhoto() }
  private func centerPhoto() {
    contentInset = UIEdgeInsets(
      top: max((bounds.height - contentSize.height) / 2, 0),
      left: max((bounds.width - contentSize.width) / 2, 0), bottom: 0, right: 0)
  }
}

struct CameraCapture: UIViewControllerRepresentable {
  var onCapture: (Data) -> Void
  @Environment(\.dismiss) private var dismiss

  @MainActor static func request(completion: @escaping @MainActor (Bool) -> Void) {
    guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
      completion(false)
      return
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: completion(true)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { allowed in
        Task { @MainActor in completion(allowed) }
      }
    default: completion(false)
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

  @MainActor
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate
  {
    let parent: CameraCapture
    init(parent: CameraCapture) { self.parent = parent }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage,
        let data = image.jpegData(compressionQuality: 1)
      {
        parent.onCapture(data)
      }
      parent.dismiss()
    }
  }
}
