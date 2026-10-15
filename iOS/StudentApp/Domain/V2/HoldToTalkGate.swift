import Foundation

// T6i：「按住说话」手势阶段状态机——长按约 0.2 秒成立才开始；成立前滑走/抬起什么都不发生，
// 避免在按钮上滑动页面误触发录音。纯逻辑，视图只把手势事件喂进来、按返回动作调用 SpeechInput。
// 「第一次按下先请求权限」同样在成立后才触发（视图只在 start 动作时调 SpeechInput.start()）。

struct HoldToTalkGate: Equatable, Sendable {
  /// 手势阶段。
  enum Phase: Equatable, Sendable {
    case idle      // 未按下
    case pressing  // 手指已按下，长按未成立
    case holding   // 长按成立
  }

  /// 手势事件。
  enum Event: Sendable {
    case touchDown            // 手指碰到按钮
    case longPressRecognized  // 长按达到 0.2 秒
    case touchUp              // 抬起 / 滑走 / 取消
    case cancelled            // T6j：系统取消（来电、滑出、页面消失、进后台）——任何阶段回到空闲
  }

  /// 状态迁移后该做什么。
  enum Action: Equatable, Sendable {
    case none, start, stop
  }

  private(set) var phase: Phase = .idle

  @discardableResult
  mutating func handle(_ event: Event) -> Action {
    switch (phase, event) {
    case (.idle, .touchDown):
      phase = .pressing
      return .none
    case (.pressing, .longPressRecognized):
      phase = .holding
      return .start
    case (.pressing, .touchUp):
      // 长按没达到时间就滑走或抬起：什么都不发生。
      phase = .idle
      return .none
    case (.holding, .touchUp):
      phase = .idle
      return .stop
    case (_, .cancelled):
      // 系统取消：任何阶段回到空闲；录音中（holding）给出停止。
      let wasHolding = phase == .holding
      phase = .idle
      return wasHolding ? .stop : .none
    default:
      // 重复/悬空事件（成立后再次回调已成立、idle 时抬起等）不改变状态。
      return .none
    }
  }
}
