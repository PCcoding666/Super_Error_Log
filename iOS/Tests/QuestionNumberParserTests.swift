import XCTest
import Foundation
@testable import StudentCore

// S2 RED：题号解析（纯逻辑）。从学生说的/输入的一句话里取题号：阿拉伯数字（含全角）、
// 中文数字、范围（到/至/-/~）；去重升序；0、大于 200、跨度超 30、倒序范围忽略。
final class QuestionNumberParserTests: XCTestCase {
  // MARK: parse

  func testPlainListsWithVariousSeparators() {
    XCTAssertEqual(QuestionNumberParser.parse("3 7 12"), [3, 7, 12])
    XCTAssertEqual(QuestionNumberParser.parse("3、7，12"), [3, 7, 12])
    XCTAssertEqual(QuestionNumberParser.parse("3,7;12"), [3, 7, 12])
  }

  func testSentencesWithQuestionWord() {
    XCTAssertEqual(QuestionNumberParser.parse("第3题和第7题"), [3, 7])
    XCTAssertEqual(QuestionNumberParser.parse("3题 7题"), [3, 7])
  }

  func testRanges() {
    XCTAssertEqual(QuestionNumberParser.parse("5到8"), [5, 6, 7, 8])
    XCTAssertEqual(QuestionNumberParser.parse("5-8"), [5, 6, 7, 8])
    XCTAssertEqual(QuestionNumberParser.parse("5~8"), [5, 6, 7, 8])
    XCTAssertEqual(QuestionNumberParser.parse("5至8"), [5, 6, 7, 8])
    XCTAssertEqual(QuestionNumberParser.parse("第5到第8题"), [5, 6, 7, 8])
  }

  func testChineseNumbers() {
    XCTAssertEqual(QuestionNumberParser.parse("第十二题"), [12])
    XCTAssertEqual(QuestionNumberParser.parse("三、十五、二十一"), [3, 15, 21])
    XCTAssertEqual(QuestionNumberParser.parse("十"), [10])
    XCTAssertEqual(QuestionNumberParser.parse("二十"), [20])
    XCTAssertEqual(QuestionNumberParser.parse("两"), [2])
  }

  func testFullWidthDigits() {
    XCTAssertEqual(QuestionNumberParser.parse("１２"), [12])
  }

  func testIgnoresEmptyZeroAndTooLarge() {
    XCTAssertEqual(QuestionNumberParser.parse(""), [])
    XCTAssertEqual(QuestionNumberParser.parse("这页都做对了"), [])
    XCTAssertEqual(QuestionNumberParser.parse("0"), [])
    XCTAssertEqual(QuestionNumberParser.parse("201"), [])
    XCTAssertEqual(QuestionNumberParser.parse("300"), [])
  }

  func testInvalidRangesIgnoredAsWhole() {
    XCTAssertEqual(QuestionNumberParser.parse("1到40"), [], "跨度超过 30 的范围整段忽略")
    XCTAssertEqual(QuestionNumberParser.parse("8到5"), [], "倒序范围整段忽略")
    XCTAssertEqual(QuestionNumberParser.parse("8到5 3"), [3], "忽略的范围不影响其余题号")
  }

  func testDedupAndSort() {
    XCTAssertEqual(QuestionNumberParser.parse("7 3 7 12 3"), [3, 7, 12])
    XCTAssertEqual(QuestionNumberParser.parse("5到7 6"), [5, 6, 7])
  }

  // MARK: leadingNumber

  func testLeadingNumber() {
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "3."), 3)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "（3）"), 3)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "3、"), 3)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "第3题"), 3)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "三"), 3)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "17(1)"), 17)
    XCTAssertEqual(QuestionNumberParser.leadingNumber(of: "17（2）"), 17)
    XCTAssertNil(QuestionNumberParser.leadingNumber(of: "附加题"))
  }

  // MARK: match

  func testMatchSelectsAllSubQuestionsAndReportsMissing() {
    let candidates: [(id: String, number: String)] = [
      ("id-3", "3"), ("id-17a", "17(1)"), ("id-17b", "17（2）"), ("id-21", "第21题"),
    ]
    let result = QuestionNumberParser.match(numbers: [3, 9, 17], candidates: candidates)
    XCTAssertEqual(result.ids, ["id-3", "id-17a", "id-17b"], "同一开头整数的多个候选（小问）全部选中")
    XCTAssertEqual(result.missing, [9])
  }

  // MARK: displayLabel（S2-R1）

  // 纯整数（含首尾带空白/标点、括号包着整数）→「第 N 题」。
  func testDisplayLabelPlainAndBracketedIntegers() {
    XCTAssertEqual(QuestionNumberParser.displayLabel("3"), "第 3 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("1."), "第 1 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("2、"), "第 2 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("（3）"), "第 3 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("(4)"), "第 4 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel(" 5．"), "第 5 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("6:"), "第 6 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("7："), "第 7 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("12．"), "第 12 题")
  }

  // 复合/非数字题号：去首尾标点后原样放中间，两侧空格。
  func testDisplayLabelCompositeKeepsOriginalInMiddle() {
    XCTAssertEqual(QuestionNumberParser.displayLabel("17(1)"), "第 17(1) 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("17（2）"), "第 17（2） 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("三"), "第 三 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("A1"), "第 A1 题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("附加题"), "第 附加题 题")
  }

  // 空串（或只剩空白/标点）→「这道题」。
  func testDisplayLabelEmptyFallsBackToGeneric() {
    XCTAssertEqual(QuestionNumberParser.displayLabel(""), "这道题")
    XCTAssertEqual(QuestionNumberParser.displayLabel("  、 "), "这道题")
  }
}
