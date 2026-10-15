import Foundation

// T6c：键盘直改（POST /v2/items/:id/correct/direct）的 changes 构造（纯逻辑）。
// 规则：before 必须与当前识别结果完全一致；只产出有改动的字段；无改动返回空数组。
// knowledgeTags 的 before/after 按接口约定为 JSON 数组字符串；逗号支持中英文。

enum DirectCorrection {
  /// 由编辑后的字段与当前识别结果比对，产出 changes。
  /// observationTexts 以观察记录 id 为键；缺键或同文视为未改动。
  static func changes(evidence: V2Evidence, questionText: String, subject: String,
    knowledgeTagsText: String, observationTexts: [String: String]) -> [V2CorrectionChange] {
    var changes: [V2CorrectionChange] = []
    if questionText != evidence.questionText {
      changes.append(V2CorrectionChange(field: .questionText, observationId: nil,
        before: evidence.questionText, after: questionText, find: nil, replace: nil))
    }
    if subject != evidence.subject {
      changes.append(V2CorrectionChange(field: .subject, observationId: nil,
        before: evidence.subject, after: subject, find: nil, replace: nil))
    }
    let tags = knowledgeTagsText
      .split(whereSeparator: { $0 == "," || $0 == "，" })
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if tags != evidence.knowledgeTags,
      let before = Self.jsonArray(evidence.knowledgeTags), let after = Self.jsonArray(tags) {
      changes.append(V2CorrectionChange(field: .knowledgeTags, observationId: nil,
        before: before, after: after, find: nil, replace: nil))
    }
    for observation in evidence.observations {
      guard let text = observationTexts[observation.id], text != observation.text else { continue }
      changes.append(V2CorrectionChange(field: .observation, observationId: observation.id,
        before: observation.text, after: text, find: nil, replace: nil))
    }
    return changes
  }

  private static func jsonArray(_ values: [String]) -> String? {
    guard let data = try? JSONEncoder().encode(values) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
