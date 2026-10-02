import XCTest
import Foundation
@testable import StudentCore

// S2-R1 RED：勾选状态——输入匹配随输入框内容整体重算（可增可减），
// 学生手点的勾上/取消单独记忆，不被后续输入冲掉。
final class PickSelectionTests: XCTestCase {
  /// 候选第 1–8 题。
  private let candidates = (1...8).map { (id: "q\($0)", number: "\($0)") }

  private func matchedIDs(_ text: String) -> Set<String> {
    Set(QuestionNumberParser.match(numbers: QuestionNumberParser.parse(text), candidates: candidates).ids)
  }

  // 逐字输入「1」→「15」：第 1 题先勾上、输入成 15 后自动取消，且 15 进 missing。
  func testTyping15Unchecks1AndReportsMissing() {
    let selection = PickSelection()
    XCTAssertEqual(selection.checked(inputIDs: matchedIDs("1")), ["q1"], "输入「1」时第 1 题勾上")
    let result = QuestionNumberParser.match(numbers: QuestionNumberParser.parse("15"), candidates: candidates)
    XCTAssertEqual(selection.checked(inputIDs: Set(result.ids)), [], "「1」变成「15」后第 1 题自动取消")
    XCTAssertEqual(result.missing, [15], "第 15 题不在这页，进 missing")
  }

  // 输入「2」勾上第 2 题 → 手点取消 → 追加输入「，8」：第 2 题保持未勾，第 8 题勾上。
  func testManualOffSurvivesLaterInput() {
    var selection = PickSelection()
    selection.toggle("q2", inputIDs: matchedIDs("2"))
    XCTAssertFalse(selection.checked(inputIDs: matchedIDs("2")).contains("q2"), "手点取消后第 2 题未勾")
    let checked = selection.checked(inputIDs: matchedIDs("2，8"))
    XCTAssertFalse(checked.contains("q2"), "追加输入后第 2 题保持未勾")
    XCTAssertTrue(checked.contains("q8"), "追加输入的第 8 题勾上")
  }

  // 手点勾上第 3 题后清空输入框：第 3 题仍勾着。
  func testManualOnSurvivesClearingInput() {
    var selection = PickSelection()
    selection.toggle("q3", inputIDs: matchedIDs(""))
    XCTAssertEqual(selection.checked(inputIDs: matchedIDs("")), ["q3"], "清空输入框后手点勾上的题仍勾着")
  }

  // 输入匹配的题手点取消、再手点一次：恢复勾选。
  func testManualToggleOffThenOnRestores() {
    var selection = PickSelection()
    let ids = matchedIDs("1")
    selection.toggle("q1", inputIDs: ids)
    XCTAssertFalse(selection.checked(inputIDs: ids).contains("q1"), "手点取消后未勾")
    selection.toggle("q1", inputIDs: ids)
    XCTAssertTrue(selection.checked(inputIDs: ids).contains("q1"), "再手点一次恢复勾选")
  }
}
