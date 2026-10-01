import SwiftUI
import UIKit

struct UploadConsentView: View {
  let names: [String]
  var agree: () -> Void
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          SectionTitle(title: "上传前，请确认", subtitle: "这次将发送 \(names.count) 张照片。")
          ForEach(names, id: \.self) { name in
            LocalPhotoThumbnail(url: store.photoURL(name)).frame(maxHeight: 180)
              .accessibilityLabel("待上传的本机照片").accessibilityIdentifier("consent-photo-\(name)")
          }
          if store.pairing?.isCloud == true {
            Text("照片将上传到你的广州云服务器，再由阿里云百炼处理。图片可能包含姓名、笔迹或其他个人信息，请先检查所选照片。")
          } else {
            Text("照片将先发送到这台 Mac 的本机识别服务，再由阿里云百炼处理。图片可能包含姓名、笔迹或其他个人信息，请先检查所选照片。")
          }
          Text("原始照片保存在本机。上传使用一次生成并保存的 JPEG 副本，可能改变压缩和方向表示；重试会发送同一份副本。服务商的数据处理不由本应用控制。")
            .font(.subheadline).foregroundStyle(Palette.muted)
          if store.pairing == nil {
            Text("尚未连接识别服务，请返回连接设置或扫码配对后再上传。").font(.subheadline).foregroundStyle(Palette.teal)
          } else if store.pairing?.isCloud == true, let state = store.connectionState, state != .ready {
            Text("当前云端连接状态：\(state.title)。上传前会重新检查连接。").font(.subheadline).foregroundStyle(Palette.teal)
          }
          Button("同意上传并识别", action: agree).buttonStyle(PrimaryButton())
            .disabled(names.isEmpty || store.pairing == nil).accessibilityIdentifier("consent-upload")
          Button("暂不上传") { dismiss() }.frame(maxWidth: .infinity)
        }.padding(24)
      }.background(Palette.paper).navigationTitle("照片上传确认").navigationBarTitleDisplayMode(.inline)
    }
  }
}

struct UploadConsentBatch: Identifiable {
  let id = UUID()
  let names: [String]
}

struct LocalPhotoThumbnail: View {
  let url: URL
  @Environment(StudyStore.self) private var store
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFit() }
      else { Image(systemName: "photo").foregroundStyle(Palette.muted) }
    }.task(id: "\(url.absoluteString):\(store.mediaRevision)") {
      image = await Task.detached { UIImage(contentsOfFile: url.path) }.value
    }
  }
}
