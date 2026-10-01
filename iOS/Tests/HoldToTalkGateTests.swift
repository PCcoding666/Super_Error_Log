import XCTest
@testable import StudentCore

// T6i：「按住说话」手势状态机——长按约 0.2 秒成立才开始；成立前滑走/抬起什么都不发生。
final class HoldToTalkGateTests: XCTestCase {

  // 快速点按（不足 0.2 秒就抬起）：不开始、不停止。
  func testQuickTapDoesNothing() {
    var gate = HoldToTalkGate()
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.handle(.touchUp), .none)
    XCTAssertEqual(gate.phase, .idle)
  }

  // 按下后直接滑走（长按未成立，手势取消）：不开始、不停止。
  func testScrollAwayBeforeLongPressDoesNothing() {
    var gate = HoldToTalkGate()
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.handle(.touchUp), .none)
    XCTAssertEqual(gate.phase, .idle)
  }

  // 长按成立：开始；松开：停止。
  func testHoldStartsThenStops() {
    var gate = HoldToTalkGate()
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.handle(.longPressRecognized), .start)
    XCTAssertEqual(gate.phase, .holding)
    XCTAssertEqual(gate.handle(.touchUp), .stop)
    XCTAssertEqual(gate.phase, .idle)
  }

  // 按住时手指微动，顺序手势会反复回调「已成立」：只开始一次。
  func testRepeatedRecognitionStartsOnlyOnce() {
    var gate = HoldToTalkGate()
    _ = gate.handle(.touchDown)
    XCTAssertEqual(gate.handle(.longPressRecognized), .start)
    XCTAssertEqual(gate.handle(.longPressRecognized), .none)
    XCTAssertEqual(gate.handle(.touchUp), .stop)
  }

  // 成立前重复按下不叠加；抬起的悬空事件无动作。
  func testStrayEventsAreIgnored() {
    var gate = HoldToTalkGate()
    XCTAssertEqual(gate.handle(.touchUp), .none)
    XCTAssertEqual(gate.handle(.longPressRecognized), .none)
    XCTAssertEqual(gate.phase, .idle)
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.phase, .pressing)
  }

  // 完整一轮结束后回到 idle，可以再次按住。
  func testCanHoldAgainAfterRelease() {
    var gate = HoldToTalkGate()
    _ = gate.handle(.touchDown)
    _ = gate.handle(.longPressRecognized)
    XCTAssertEqual(gate.handle(.touchUp), .stop)
    XCTAssertEqual(gate.handle(.touchDown), .none)
    XCTAssertEqual(gate.handle(.longPressRecognized), .start)
    XCTAssertEqual(gate.handle(.touchUp), .stop)
  }
}
