import SwiftUI
import PhotosUI
import UIKit

/// 系统相机（一次一张）。模拟器没有相机，调用方先看 `isAvailable`。
struct CameraPicker: UIViewControllerRepresentable {
  static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
  let onCapture: (Data) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) { parent.onCapture(data) }
      parent.dismiss()
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
  }
}

/// 拍照 + 相册两个入口。选完的原始字节交给 `onPicked`（由调用方丢进上传队列）。
/// 相册可以一次选多张；拍照一次一张。
struct CaptureControls: View {
  enum Style { case fab, text, empty }

  let style: Style
  let onPicked: ([Data]) -> Void

  @State private var pickerItems: [PhotosPickerItem] = []
  @State private var showCamera = false

  var body: some View {
    layout
      .fullScreenCover(isPresented: $showCamera) {
        CameraPicker { onPicked([$0]) }.ignoresSafeArea()
      }
      .onChange(of: pickerItems) { _, items in
        guard !items.isEmpty else { return }
        pickerItems = []
        Task {
          var photos: [Data] = []
          for item in items { if let data = try? await item.loadTransferable(type: Data.self) { photos.append(data) } }
          if !photos.isEmpty { onPicked(photos) }
        }
      }
  }

  @ViewBuilder
  private var layout: some View {
    switch style {
    case .fab:
      VStack(spacing: 12) {
        if CameraPicker.isAvailable {
          Button { showCamera = true } label: { FabCircle(symbol: "camera.fill") }
            .accessibilityLabel("拍照").accessibilityIdentifier("capture-camera")
        }
        PhotosPicker(selection: $pickerItems, maxSelectionCount: 20, matching: .images) { FabCircle(symbol: "photo.on.rectangle.angled") }
          .accessibilityLabel("从相册选择").accessibilityIdentifier("capture-album")
      }
    case .text:
      HStack(spacing: 28) {
        if CameraPicker.isAvailable {
          Button { showCamera = true } label: { Label("拍照", systemImage: "camera") }
            .accessibilityIdentifier("intake-camera")
        }
        PhotosPicker(selection: $pickerItems, maxSelectionCount: 20, matching: .images) { Label("从相册选择", systemImage: "photo.on.rectangle") }
          .accessibilityIdentifier("intake-album")
      }
    case .empty:
      VStack(spacing: 12) {
        if CameraPicker.isAvailable {
          Button { showCamera = true } label: { Label("去拍照", systemImage: "camera.fill").frame(maxWidth: 260) }
            .buttonStyle(.borderedProminent).accessibilityIdentifier("capture-camera")
        }
        PhotosPicker(selection: $pickerItems, maxSelectionCount: 20, matching: .images) { Label("从相册选择", systemImage: "photo.on.rectangle").frame(maxWidth: 260) }
          .buttonStyle(.bordered).accessibilityIdentifier("capture-album")
      }
      .controlSize(.large)
    }
  }

}

private struct FabCircle: View {
  let symbol: String
  var body: some View {
    Image(systemName: symbol).font(.title3.weight(.semibold)).foregroundStyle(Palette.onTeal)
      .frame(width: 56, height: 56).background(Palette.teal, in: Circle())
      .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
  }
}

extension View {
  /// 给一块容器做标识，同时保留里面各控件自己的标识（直接对 VStack 设标识会把它盖到所有子控件上）。
  func containerIdentifier(_ identifier: String) -> some View {
    accessibilityElement(children: .contain).accessibilityIdentifier(identifier)
  }
}
