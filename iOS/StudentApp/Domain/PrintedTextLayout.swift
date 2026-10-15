import Foundation
import CoreText
import CoreGraphics

enum PrintedTextLayout {
  static func attributedText(_ text: String) -> NSAttributedString {
    NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("PingFangSC-Regular" as CFString, 16, nil),
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
    ])
  }

  static func ranges(for text: String, width: Double, height: Double) throws -> [NSRange] {
    guard !text.isEmpty, width > 0, height > 0 else { throw StudyError.emptySelection }
    let setter = CTFramesetterCreateWithAttributedString(attributedText(text))
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: width, height: height), transform: nil)
    let length = (text as NSString).length
    var location = 0
    var ranges: [NSRange] = []
    while location < length {
      let frame = CTFramesetterCreateFrame(setter, CFRange(location: location, length: 0), path, nil)
      let visible = CTFrameGetVisibleStringRange(frame)
      guard visible.length > 0 else { throw StudyError.unsupportedState }
      ranges.append(NSRange(location: location, length: visible.length))
      location += visible.length
    }
    return ranges
  }
}
