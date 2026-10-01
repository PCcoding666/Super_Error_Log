import AVFoundation
import Speech
import SwiftUI

// T6c：语音输入（仅 App target）。SFSpeechRecognizer（zh-CN），支持端上识别时
// requiresOnDeviceRecognition = true；AVAudioEngine 取麦克风；音频不落盘、不上传，
// 只把转出的文字放进输入框，学生可改后再发。被拒绝或设备不支持时界面只留键盘。

@MainActor @Observable
final class SpeechInput {
  private(set) var isRecording = false
  /// 授权通过且设备支持才为 true；false 时界面隐藏说话按钮、只留键盘。
  private(set) var isAvailable = false
  /// 识别出的文字（松开结束后的最终结果或过程中的最新片段）。
  var onText: (String) -> Void = { _ in }

  private var recognizer: SFSpeechRecognizer?
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?

  init() {
    // requiresOnDeviceRecognition 设在识别请求上（见 start）。
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else { return }
    self.recognizer = recognizer
  }

  /// 首次使用时请求语音识别与麦克风授权；被拒绝或设备不支持时 isAvailable 保持 false。
  func prepare() async {
    guard let recognizer, recognizer.isAvailable else { isAvailable = false; return }
    let speechGranted = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
    guard speechGranted else { isAvailable = false; return }
    isAvailable = await AVAudioApplication.requestRecordPermission()
  }

  /// 按下开始。进行中的重复调用直接忽略。
  func start() {
    guard isAvailable, !isRecording, let recognizer, recognizer.isAvailable else { return }
    recognitionTask?.cancel()
    recognitionTask = nil
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        return
      }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      engine.prepare()
      try engine.start()
    } catch {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      return
    }
    self.engine = engine
    self.request = request
    isRecording = true
    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      // 只把文字交回调用方；不写日志、不落盘。
      guard let result else { return }
      let text = result.bestTranscription.formattedString
      Task { @MainActor [weak self] in self?.onText(text) }
      if error != nil || result.isFinal {
        Task { @MainActor [weak self] in self?.finish() }
      }
    }
  }

  /// 松开结束：停止取音，让识别任务收尾（最终结果经 onText 回填）。
  func stop() {
    guard isRecording else { return }
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    isRecording = false
  }

  /// 识别任务结束（最终结果或出错）后的清理。
  private func finish() {
    stop()
    recognitionTask = nil
    request = nil
    engine = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// 「按住说话」按钮：按下开始、松开结束。语音不可用或被拒绝时由调用方隐藏本按钮。
struct HoldToTalkButton: View {
  let speech: SpeechInput
  var identifier: String

  var body: some View {
    Label(speech.isRecording ? "正在听，松开结束" : "按住说话", systemImage: "mic.fill")
      .font(.subheadline.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 44)
      .foregroundStyle(speech.isRecording ? Palette.onTeal : Palette.teal)
      .background(speech.isRecording ? Palette.teal : Palette.mint,
        in: RoundedRectangle(cornerRadius: 14))
      .contentShape(RoundedRectangle(cornerRadius: 14))
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in speech.start() }
          .onEnded { _ in speech.stop() }
      )
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(speech.isRecording ? "正在听，松开结束" : "按住说话")
      .accessibilityIdentifier(identifier)
      .accessibilityAddTraits(.isButton)
  }
}
