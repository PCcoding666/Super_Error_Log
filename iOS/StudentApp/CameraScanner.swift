import AVFoundation
import SwiftUI
import UIKit

/// Task 4: 实际相机扫码组件（AVFoundation 扫码 + 相机权限中文说明与拒绝后引导）。
/// 识别到合法配对二维码后回调；仅限固定云域名 HTTPS payload。
struct CameraScanner: UIViewControllerRepresentable {
  var onPayload: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  @MainActor static func requestCamera(completion: @escaping @MainActor (Bool) -> Void) {
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

  func makeUIViewController(context: Context) -> ScannerViewController {
    let controller = ScannerViewController()
    controller.onPayload = { payload in
      onPayload(payload)
    }
    controller.onCancel = {
      dismiss()
    }
    return controller
  }
  func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

/// AVFoundation 扫码控制器：metadata 输出 + 中文权限说明 + 拒绝后引导。
@MainActor
final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
  var onPayload: ((String) -> Void)?
  var onCancel: (() -> Void)?
  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var layoutObservation: NSKeyValueObservation?
  private var didReport = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    configureSession()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if !session.isRunning { return }
    session.stopRunning()
  }

  private func configureSession() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      startSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
        Task { @MainActor in
          if allowed { self?.startSession() }
          else { self?.showPermissionDenied() }
        }
      }
    default:
      showPermissionDenied()
    }
  }

  private func startSession() {
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input) else {
      showUnavailable()
      return
    }
    session.beginConfiguration()
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      showUnavailable()
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    session.commitConfiguration()
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.insertSublayer(preview, at: 0)
    previewLayer = preview
    // Task 4 review R3：旋转/布局变化后预览层跟随边界，避免取景错位。
    layoutObservation = view.observe(\.bounds, options: [.new]) { [weak self] observed, _ in
      Task { @MainActor in self?.previewLayer?.frame = observed.bounds }
    }
    let hint = UILabel()
    hint.text = "对准 Mac 管理界面上的配对二维码"
    hint.textColor = .white
    hint.font = .preferredFont(forTextStyle: .headline)
    hint.textAlignment = .center
    hint.numberOfLines = 0
    hint.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hint)
    NSLayoutConstraint.activate([
      hint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -32),
      hint.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      hint.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
    ])
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      if !self.session.isRunning { self.session.startRunning() }
    }
  }

  private func showPermissionDenied() {
    showGuidance(
      title: "无法使用相机",
      message: "扫码配对需要相机权限。请在系统设置中允许「超级错题本」访问相机，然后返回重试。",
      settings: true)
  }

  private func showUnavailable() {
    showGuidance(
      title: "相机不可用",
      message: "这台设备当前无法启动相机扫码。请检查相机是否被占用，或改用其他方式配对。",
      settings: false)
  }

  private func showGuidance(title: String, message: String, settings: Bool) {
    let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
    if settings {
      alert.addAction(UIAlertAction(title: "前往设置", style: .default) { _ in
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      })
    }
    alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
      self?.onCancel?()
    })
    present(alert, animated: true)
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection) {
    guard !didReport,
      let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
      object.type == .qr, let payload = object.stringValue
    else { return }
    didReport = true
    onPayload?(payload)
  }
}
