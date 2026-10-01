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
  /// 「第一次按下先请求权限」进行中标记：按住时手指微动会反复触发 start()，
  /// 请求进行中再次进入直接返回，避免并发发起多次权限请求。
  private var isRequestingPermissions = false

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
      guard !isRequestingPermissions else { return }
      isRequestingPermissions = true
      Task { await requestPermissions() }
    case .holdToTalk:
      beginRecording()
    }
  }

  /// 第一次按下：请求语音识别与麦克风授权。通过后提示「再按一次开始说」；任一被拒只留键盘。
  private func requestPermissions() async {
    defer { isRequestingPermissions = false }
    guard let recognizer, recognizer.isAvailable else { presentation = .keyboardOnly; return }
    let speechGranted = await Self.requestSpeechAuthorization()
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
      // input/format 在本 SDK 已是 Sendable 可直接传递；识别请求对象只在本次录音内
      // 使用：主线程创建与收尾、系统音频/后台线程回调，由 stop()/finish() 串行释放，
      // 不存在并发访问，故用 nonisolated(unsafe) 显式传递引用。
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        return
      }
      nonisolated(unsafe) let tapRequest = request
      Self.installTap(on: input, format: format, request: tapRequest)
      engine.prepare()
      try engine.start()
    } catch {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      return
    }
    self.engine = engine
    self.request = request
    isRecording = true
    // 同上：识别器与请求对象只服务于本次录音，回调只回传可跨线程的 String?/Bool。
    nonisolated(unsafe) let taskRecognizer = recognizer
    nonisolated(unsafe) let taskRequest = request
    recognitionTask = Self.startRecognition(recognizer: taskRecognizer, request: taskRequest) { [weak self] transcript, finished in
      Task { @MainActor [weak self] in
        guard let self else { return }
        // 只把文字交回调用方；不写日志、不落盘。
        if let transcript {
          self.onText(SpeechText.merge(base: self.base, transcript: transcript))
        }
        // 出错或最终结果都要收尾（释放音频会话）。
        if finished {
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

  // MARK: - 系统回调的创建（nonisolated：系统在后台线程调用，闭包不能继承主线程隔离，
  // 否则 Swift 6 运行时检查直接中止进程——T6c-R2 闪退根因）

  /// 请求语音识别授权。系统回调在后台线程触发，闭包只恢复 continuation。
  private nonisolated static func requestSpeechAuthorization() async -> Bool {
    await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
  }

  /// 安装音频 Tap。回调在音频渲染线程触发，闭包只把 buffer 追加进识别请求
  ///（SFSpeechAudioBufferRecognitionRequest.append 可在任意线程调用）。
  private nonisolated static func installTap(on input: AVAudioInputNode, format: AVAudioFormat,
    request: SFSpeechAudioBufferRecognitionRequest) {
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
  }

  /// 启动识别任务。结果回调在后台队列触发，闭包只回传可跨线程的 String?/Bool，
  /// 不把 SFSpeechRecognitionResult 带回主线程。
  private nonisolated static func startRecognition(recognizer: SFSpeechRecognizer,
    request: SFSpeechAudioBufferRecognitionRequest,
    onUpdate: @escaping @Sendable (_ transcript: String?, _ finished: Bool) -> Void) -> SFSpeechRecognitionTask {
    recognizer.recognitionTask(with: request) { result, error in
      onUpdate(result?.bestTranscription.formattedString, error != nil || result?.isFinal == true)
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

/// T6g：「按住说话」控件组——CorrectionSheet 与 FollowupView 共用。
/// 识别器可用时显示按钮（按下先请求权限则带提示）；不可用或被拒绝时只留「可以直接打字」。
struct SpeechControls: View {
  let speech: SpeechInput
  /// 按钮的无障碍标识符（如 correction-hold-to-talk / followup-hold-to-talk）。
  var holdIdentifier: String
  /// 「可以直接打字」的无障碍标识符（如 correction-type-instead / followup-type-instead）。
  var typeInsteadIdentifier: String
  /// 授权提示的无障碍标识符。
  var hintIdentifier: String

  var body: some View {
    switch speech.presentation {
    case .holdToTalk, .askOnPress:
      HoldToTalkButton(speech: speech, identifier: holdIdentifier)
      if let hint = speech.hint {
        Text(hint).font(.caption).foregroundStyle(Palette.muted)
          .accessibilityIdentifier(hintIdentifier)
      }
    case .keyboardOnly:
      Text("可以直接打字").font(.caption).foregroundStyle(Palette.muted)
        .accessibilityIdentifier(typeInsteadIdentifier)
    }
  }
}
