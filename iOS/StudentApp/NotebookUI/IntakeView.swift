import SwiftUI

/// 录入态：一次上传算一个批次，按照片分段；找到的题默认已在错题本，左滑删掉不相关的；
/// 没批改痕迹的页勾出做错的题。对照 client/src/pages/IntakePage.tsx。
struct IntakeView: View {
  @State private var model: IntakeModel
  let onPicked: ([Data]) -> Void
  let openItem: (String) -> Void
  let done: () -> Void
  @State private var viewing: IntakePhoto?

  init(api: any WebAPI, uploads: UploadQueue, onPicked: @escaping ([Data]) -> Void,
    openItem: @escaping (String) -> Void, done: @escaping () -> Void) {
    _model = State(initialValue: IntakeModel(api: api, uploads: uploads))
    self.onPicked = onPicked
    self.openItem = openItem
    self.done = done
  }

  var body: some View {
    List {
      Text(model.status).font(.subheadline).foregroundStyle(.secondary)
        .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 4))
        .accessibilityIdentifier("intake-status")
      if !model.uploads.pendingEntries.isEmpty { uploadSection }
      if let error = model.error {
        VStack(spacing: 8) {
          Text(error.message).font(.subheadline).foregroundStyle(CardTone.red.color).multilineTextAlignment(.center)
          Button("再试一次") { Task { await model.reload() } }
        }
        .frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
      ForEach(Array(model.current.enumerated()), id: \.element.id) { index, photo in photoSection(photo, index: index) }
      if !model.earlier.isEmpty {
        Section {
          DisclosureGroup("更早的 \(model.earlier.count) 张") {
            ForEach(model.earlier) { photo in photoRows(photo, index: nil) }
          }
        }
      }
      Color.clear.frame(height: 80).listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
    .listStyle(.insetGrouped)
    .navigationTitle("录入")
    .navigationBarTitleDisplayMode(.large)
    .safeAreaInset(edge: .bottom) { bottomBar }
    .refreshable { await model.reload() }
    .task { await model.reload(); model.startPolling() }
    .onDisappear { model.stopPolling() }
    .onChange(of: model.uploads.succeededCount) { _, _ in Task { await model.reload() } }
    .fullScreenCover(item: $viewing) { photo in PhotoViewer(title: "第 \(photo.number) 张", path: photo.full) }
    .overlay(alignment: .bottom) {
      if let toast = model.toast {
        Text(toast).font(.subheadline).foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 12)
          .background(Color.black.opacity(0.82), in: Capsule()).padding(.bottom, 110)
          .task(id: toast) { try? await Task.sleep(for: .seconds(3)); if model.toast == toast { model.toast = nil } }
      }
    }
    .animation(.default, value: model.toast)
  }

  // MARK: - 上传中

  private var uploadSection: some View {
    Section {
      ForEach(model.uploads.pendingEntries) { entry in
        HStack(spacing: 12) {
          thumbnail(entry.preview)
          VStack(alignment: .leading, spacing: 2) {
            Text(entry.name).font(.headline)
            Text(entry.message).font(.subheadline).foregroundStyle(entry.state == .failed ? CardTone.red.color : .secondary)
            if entry.state == .uploading { ProgressView(value: entry.progress) }
          }
          Spacer(minLength: 0)
          if entry.state == .preparing || entry.state == .uploading { ProgressView() }
        }
        .accessibilityIdentifier("upload-row")
      }
      if model.uploads.pendingEntries.contains(where: { $0.state == .failed && $0.retryable }) {
        Button("再试一次") { model.uploads.retry() }.accessibilityIdentifier("upload-retry")
      }
    }
  }

  private func thumbnail(_ data: Data?) -> some View {
    Group {
      if let data, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
      else { Rectangle().fill(Color(.tertiarySystemFill)) }
    }
    .frame(width: 44, height: 56).clipShape(RoundedRectangle(cornerRadius: 6))
  }

  // MARK: - 每张照片

  private func photoSection(_ photo: IntakePhoto, index: Int) -> some View {
    Section { photoRows(photo, index: model.current.count > 1 ? index + 1 : nil) }
  }

  @ViewBuilder
  private func photoRows(_ photo: IntakePhoto, index: Int?) -> some View {
    HStack(spacing: 12) {
      Button { viewing = photo } label: {
        RemoteImage(path: photo.thumb, maxPixel: 300, contentMode: .fill, placeholderRatio: 0.8)
          .frame(width: 44, height: 56).clipShape(RoundedRectangle(cornerRadius: 6))
      }
      .buttonStyle(.plain).accessibilityLabel("查看原图")
      VStack(alignment: .leading, spacing: 2) {
        Text("第 \(index ?? photo.number) 张\(photo.questions.isEmpty ? "" : " · \(photo.questions.count) 道")").font(.headline)
        Text("\(Self.timeLabel(photo.takenDate)) · \(photo.statusText)").font(.subheadline).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      if photo.stateValue == .finding { ProgressView() }
    }
    .accessibilityElement(children: .contain).accessibilityIdentifier("photo-row-\(photo.number)")
    ForEach(photo.questions) { question in
      Button { openItem(question.id) } label: {
        HStack(spacing: 12) {
          RemoteImage(path: question.thumb, maxPixel: 300, contentMode: .fill, placeholderRatio: 1.2)
            .frame(width: 48, height: 40).clipShape(RoundedRectangle(cornerRadius: 6))
          VStack(alignment: .leading, spacing: 2) {
            Text(question.excerpt.isEmpty ? "题目文字暂不可用" : question.excerpt).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
            Text(question.chapter).font(.caption).foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
        }
      }
      .buttonStyle(.plain).accessibilityIdentifier("intake-question")
      .swipeActions(edge: .trailing, allowsFullSwipe: true) {
        Button(role: .destructive) { Task { await model.remove(itemID: question.id) } } label: { Text("删除") }
      }
    }
    if !photo.candidates.isEmpty {
      Text("这页没有批改痕迹，勾出做错的题").font(.footnote).foregroundStyle(.secondary)
      ForEach(photo.candidates) { candidate in
        let on = model.picked[photo.id]?.contains(candidate.id) ?? false
        Button { model.togglePick(photoID: photo.id, candidateID: candidate.id) } label: {
          HStack(spacing: 12) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.title3).foregroundStyle(on ? Palette.teal : .secondary)
            if let crop = candidate.crop {
              RemoteImage(path: crop, maxPixel: 300, contentMode: .fill, placeholderRatio: 1.2)
                .frame(width: 48, height: 40).clipShape(RoundedRectangle(cornerRadius: 6))
            }
            VStack(alignment: .leading, spacing: 2) {
              Text(candidate.excerpt.isEmpty ? candidate.label : candidate.excerpt).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
              if !candidate.excerpt.isEmpty { Text(candidate.label).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
          }
        }
        .buttonStyle(.plain).accessibilityIdentifier("pick-candidate")
      }
      let count = model.picked[photo.id]?.count ?? 0
      Button { Task { await model.include(photo) } } label: { Text(count > 0 ? "加入 \(count) 道" : "加入").frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).disabled(count == 0).accessibilityIdentifier("pick-submit")
    }
    if let failure = photo.failure {
      VStack(alignment: .leading, spacing: 6) {
        Text(failure.detail).font(.subheadline).foregroundStyle(CardTone.red.color)
        HStack {
          if failure.retryable { Button("重试") { Task { await model.retry(photo) } } }
          if model.data?.mode == "legacy" { Button("不要了") { Task { await model.dismiss(photo) } }.foregroundStyle(.secondary) }
        }
        .buttonStyle(.borderless)
      }
    }
  }

  static func timeLabel(_ date: Date?) -> String {
    guard let date else { return "" }
    let calendar = Calendar.current
    let parts = calendar.dateComponents([.month, .day, .hour, .minute], from: date)
    let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    return calendar.isDateInToday(date) ? "今天 \(time)" : "\(parts.month ?? 0)/\(parts.day ?? 0) \(time)"
  }

  // MARK: - 底部

  private var bottomBar: some View {
    VStack(spacing: 10) {
      Button {
        model.uploads.finishBatch()
        done()
      } label: { Label("完成", systemImage: "checkmark").frame(maxWidth: .infinity).padding(.vertical, 6) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("intake-done")
      CaptureControls(style: .text, onPicked: onPicked).font(.subheadline)
    }
    .padding(.horizontal, 20).padding(.vertical, 12)
    .background(.bar)
  }
}
