import AVFoundation
import Speech
import SwiftUI

// T6c：语音输入（仅 App target）。SFSpeechRecognizer（zh-CN），支持端上识别时
// requiresOnDeviceRecognition = true；AVAudioEngine 取麦克风；音频不落盘、不上传，
// 只把转出的文字放进输入框，学生可改后再发。
// T6c-R1：权限不在面板出现时请求——识别器存在且授权是「还没问过」或「已允许」就显示
// 「按住说话」，第一次按下才请求两项权限（本次按压不录音，通过后提示再按一次）；
// 被拒绝或设备不支持时只留键盘。回填是相对按下时基底的整句替换（SpeechText.merge），不追加。

@MainActor @Observable
final class SpeechInput {
  private(set) var isRecording = false
  /// 界面呈现：按住即可说 / 显示按钮但按下先请求权限 / 只留键盘。
  private(set) var presentation: SpeechGate.Presentation = .keyboardOnly
  /// 授权通过后提示学生再按一次；开始录音时清除。
  private(set) var hint: String?
  /// 识别出的文字：基底 + 本次整句（替换语义，调用方直接回填输入框）。
  var onText: (String) -> Void = { _ in }
  /// 按下时输入框里已有的文字（基底）。由界面提供。
  var currentText: () -> String = { "" }

  private var recognizer: SFSpeechRecognizer?
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var base = ""

  init() {
    // requiresOnDeviceRecognition 设在识别请求上（见 beginRecording）。
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else { return }
    self.recognizer = recognizer
  }

  /// 面板出现时调用：只读授权状态决定按钮显隐，不请求权限。
  func refresh() {
    guard let recognizer, recognizer.isAvailable else { presentation = .keyboardOnly; return }
    presentation = SpeechGate.presentation(recognizerExists: true,
      speech: Self.authState(SFSpeechRecognizer.authorizationStatus()),
      mic: Self.authState(AVAudioApplication.shared.recordPermission))
  }

  /// 按下。askOnPress 时本次不录音、只请求两项权限；holdToTalk 时开始录音。
  /// 进行中的重复调用直接忽略。
  func start() {
    switch presentation {
    case .keyboardOnly:
      break
    case .askOnPress:
      Task { await requestPermissions() }
    case .holdToTalk:
      beginRecording()
    }
  }

  /// 第一次按下：请求语音识别与麦克风授权。通过后提示「再按一次开始说」；任一被拒只留键盘。
  private func requestPermissions() async {
    guard let recognizer, recognizer.isAvailable else { presentation = .keyboardOnly; return }
    let speechGranted = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
    let micGranted = speechGranted ? await AVAudioApplication.requestRecordPermission() : false
    if speechGranted, micGranted {
      presentation = .holdToTalk
      hint = "再按一次开始说"
    } else {
      presentation = .keyboardOnly
    }
  }

  private func beginRecording() {
    guard !isRecording, let recognizer, recognizer.isAvailable else { return }
    base = currentText()
    hint = nil
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
      Task { @MainActor [weak self] in
        guard let self else { return }
        if let result {
          self.onText(SpeechText.merge(base: self.base, transcript: result.bestTranscription.formattedString))
        }
        // 出错时无论有没有结果都要收尾（释放音频会话）；最终结果同样收尾。
        if error != nil || result?.isFinal == true {
          self.finish()
        }
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

  private static func authState(_ status: SFSpeechRecognizerAuthorizationStatus) -> SpeechGate.Auth {
    switch status {
    case .notDetermined: .notAsked
    case .authorized: .allowed
    default: .denied
    }
  }

  private static func authState(_ permission: AVAudioApplication.recordPermission) -> SpeechGate.Auth {
    switch permission {
    case .undetermined: .notAsked
    case .granted: .allowed
    default: .denied
    }
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
