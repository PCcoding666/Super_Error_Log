import Foundation

struct SampleProblem: Identifiable, Sendable {
  let id: String
  let source: String
  let number: String
  let title: String
  let topic: String
  let stem: String
  let sourceNote: String
  let symbol: String

  static func find(_ id: String) -> SampleProblem? { all.first { $0.id == id } }

  // Prepared source text, NOT a model response or a claim of pipeline acceptance.
  // Keep original work out of printable stems. Full photos remain independently inspectable.
  static let all: [SampleProblem] = [
    SampleProblem(
      id: "5516-14", source: "IMG_5516", number: "14", title: "一次小小的计算",
      topic: "一元二次方程",
      stem:
        "14.（2025 武昌联考）已知关于 x 的一元二次方程 x²−(k+2)x+2k=0。\n\n(1) 求证：无论 k 为何值，此方程总有一个根是定值；\n\n(2) 若直角三角形的一边长为 3，另两边的长恰好是该方程的两根，求 k 的值。",
      sourceNote:
        "Your original working shows √16; a later correction shows √13. What would help you catch a slip like this?",
      symbol: "function"),
    SampleProblem(
      id: "5518-13", source: "IMG_5518", number: "13", title: "理清根的关系",
      topic: "根与系数的关系",
      stem: "13. 已知关于 x 的方程 x²−(m−1)x+(m²+m−5)=0 的两个根互为倒数，求 m 的值。",
      sourceNote:
        "Several lines of working overlap. Use the original photo to revisit your thinking; the prototype does not guess the crossed-out steps.",
      symbol: "x.squareroot"),
    SampleProblem(
      id: "5517-4", source: "IMG_5517", number: "4", title: "看见式子间的联系",
      topic: "代数式与方程的根",
      stem:
        "4. 已知 x₁，x₂ 是方程 x²+5x+1=0 的两个实数根，求下列各式的值：\n\n(1) x₁(1+x₂)+x₂；\n\n(2) (x₁−x₂)²；\n\n(3) x₂/x₁+x₁/x₂。",
      sourceNote:
        "Look back at your original working. Decide for yourself which part is worth trying again.",
      symbol: "arrow.triangle.branch"),
  ]
}

enum ReflectionOptions {
  static let attempts = ["I had a plan", "I got stuck partway", "I was unsure"]
  static let takeaways = [
    "Check each calculation", "Choose a different method", "Read the question more carefully",
    "I’m not sure yet",
  ]
  static let confidences = ["On my own", "With a hint", "I need to learn it again"]
  static let paperOutcomes = [
    "I solved it independently", "I needed a hint", "I’m still working on it",
  ]

  private static let chineseTitles = [
    "I had a plan": "当时有思路",
    "I got stuck partway": "做到一半卡住了",
    "I was unsure": "一开始就没把握",
    "Check each calculation": "检查每一步计算",
    "Choose a different method": "换一种方法",
    "Read the question more carefully": "先读清题目条件",
    "I’m not sure yet": "还没想清楚",
    "On my own": "能独立完成",
    "With a hint": "需要一点提示",
    "I need to learn it again": "还要再学一下",
    "I solved it independently": "这次独立做出来了",
    "I needed a hint": "看了提示才做出来",
    "I’m still working on it": "还没有做出来",
  ]

  static func displayTitle(for storedValue: String) -> String {
    chineseTitles[storedValue] ?? storedValue
  }
}
