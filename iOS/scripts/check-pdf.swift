import Foundation
import PDFKit

// Read-only verification using the same native PDF engine as the app.
// Some third-party parsers mishandle Quartz's CJK character map: render too.
guard CommandLine.arguments.count >= 2,
  let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])),
  let text = document.string
else {
  fatalError("Pass a readable exported review-pack PDF")
}
precondition(document.pageCount > 0)
let syntheticLong = CommandLine.arguments.contains("--synthetic-long")
for index in 0..<document.pageCount {
  let page = document.page(at: index)!
  let bounds = page.bounds(for: .mediaBox)
  precondition(abs(bounds.width - 595.28) < 1 && abs(bounds.height - 841.89) < 1, "Must be A4")
  precondition(page.string?.contains(syntheticLong ? "已确认题目" : "示例题") == true)
  if !syntheticLong { precondition(page.string?.contains("我的演算过程") == true) }
}
precondition(text.contains("我的演算过程"))
if syntheticLong {
  precondition(document.pageCount >= 4, "Long stem and working space must paginate")
  for number in 1...65 {
    precondition(text.contains("第\(number)小问"), "Every synthetic subquestion must survive export")
  }
  precondition(!text.contains("合成订正内容"), "Source observations must never enter the PDF")
}
precondition(
  !text.contains("√16") && !text.contains("√13"), "Do not include original answers or corrections")
if text.contains("5516") {
  precondition(
    text.contains("直角三角形") && text.contains("(1)") && text.contains("(2)"), "Full Q14 is required")
}
print(
  "已验证 \(document.pageCount) 张 A4 页面、演算空间、来源标签，且没有原答案。")
