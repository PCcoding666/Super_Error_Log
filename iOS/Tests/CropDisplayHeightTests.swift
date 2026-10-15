import XCTest
import Foundation
@testable import StudentCore

// T6c-R2 RED: 题目详情页裁图显示高度 = 可用宽度 × 图片高 ÷ 图片宽，夹在 [80, 420]。
final class CropDisplayHeightTests: XCTestCase {

  // 宽条（整题裁图的典型形态）：折算后低于下限 → 夹到 80。
  func testWideStripClampsToMinimum() {
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 2000, imageHeight: 200, availableWidth: 358), 80)
  }

  // 接近方形：折算高度 ≈ 可用宽度本身，落在区间内原样返回。
  func testNearSquareKeepsProportionalHeight() {
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 1000, imageHeight: 1000, availableWidth: 358), 358, accuracy: 0.001)
  }

  // 极高图：折算后超过上限 → 夹到 420。
  func testVeryTallImageClampsToMaximum() {
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 200, imageHeight: 2000, availableWidth: 358), 420)
  }

  // 非法输入（零或负值）退回最小高度，不产生除零或负高度。
  func testInvalidInputFallsBackToMinimum() {
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 0, imageHeight: 200, availableWidth: 358), 80)
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 1000, imageHeight: 0, availableWidth: 358), 80)
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 1000, imageHeight: 200, availableWidth: 0), 80)
  }

  // T6g RED：修改面板的整题大图上限 260pt——传入更小上限时夹到该上限，缺省仍是 420。
  func testCustomMaximumClampsLower() {
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 200, imageHeight: 2000, availableWidth: 358, maxHeight: 260), 260)
    XCTAssertEqual(CropDisplayHeight.displayHeight(imageWidth: 200, imageHeight: 2000, availableWidth: 358), 420)
  }
}
