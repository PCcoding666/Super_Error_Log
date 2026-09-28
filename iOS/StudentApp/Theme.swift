import SwiftUI
import UIKit

/// M1：动态配色（浅色/深色双套），不再强制浅色模式。
enum Palette {
  private static func dynamic(_ light: (CGFloat, CGFloat, CGFloat), _ dark: (CGFloat, CGFloat, CGFloat)) -> Color {
    Color(uiColor: UIColor { trait in
      let v = trait.userInterfaceStyle == .dark ? dark : light
      return UIColor(red: v.0, green: v.1, blue: v.2, alpha: 1)
    })
  }
  static let paper = dynamic((0.97, 0.96, 0.93), (0.09, 0.10, 0.11))
  static let card = dynamic((1, 1, 1), (0.13, 0.15, 0.16))
  static let ink = dynamic((0.12, 0.20, 0.22), (0.91, 0.93, 0.93))
  static let muted = dynamic((0.36, 0.42, 0.43), (0.62, 0.66, 0.66))
  static let teal = dynamic((0.12, 0.38, 0.36), (0.42, 0.72, 0.68))
  static let mint = dynamic((0.87, 0.92, 0.87), (0.15, 0.23, 0.21))
  static let peach = dynamic((0.97, 0.87, 0.78), (0.26, 0.19, 0.12))
  static let line = dynamic((0.86, 0.88, 0.84), (0.24, 0.27, 0.27))
  /// 主按钮文字色：深色下 teal 是浅青，白字对比不足——深色改用深墨。
  static let onTeal = dynamic((1, 1, 1), (0.05, 0.09, 0.09))
}

/// M1：状态语义色对应的 Color（五色规则：灰=仅本机/待更新，蓝=系统在工作，橙=待你核对，绿=已确认，红=失败可重试）。
extension CardTone {
  var color: Color {
    switch self {
    case .gray: Palette.muted
    case .blue: Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 0.45, green: 0.65, blue: 0.95, alpha: 1) : UIColor(red: 0.18, green: 0.43, blue: 0.87, alpha: 1) })
    case .orange: Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 0.91, green: 0.64, blue: 0.36, alpha: 1) : UIColor(red: 0.71, green: 0.33, blue: 0.04, alpha: 1) })
    case .green: Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 0.42, green: 0.75, blue: 0.54, alpha: 1) : UIColor(red: 0.12, green: 0.50, blue: 0.31, alpha: 1) })
    case .red: Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
      ? UIColor(red: 0.88, green: 0.45, blue: 0.38, alpha: 1) : UIColor(red: 0.75, green: 0.22, blue: 0.17, alpha: 1) })
    }
  }
}

struct PrimaryButton: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 17)
      .foregroundStyle(Palette.onTeal).background(
        isEnabled ? Palette.teal : Palette.muted.opacity(0.4),
        in: RoundedRectangle(cornerRadius: 18)
      )
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}

struct Eyebrow: View {
  let text: String
  var body: some View {
    Text(text.uppercased()).font(.system(.caption, design: .monospaced, weight: .semibold))
      .tracking(2).foregroundStyle(Palette.muted)
  }
}

struct PaperCard<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    content.padding(20).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: 24))
      .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Palette.line.opacity(0.5)))
  }
}

struct ChoiceRow: View {
  let title: String
  let isSelected: Bool
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle").font(.title3)
          .foregroundStyle(isSelected ? Palette.teal : Palette.muted)
        Text(title).font(.body.weight(.medium)).foregroundStyle(Palette.ink).multilineTextAlignment(
          .leading)
        Spacer(minLength: 0)
      }.padding(17).frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .background(isSelected ? Palette.mint : Palette.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
          RoundedRectangle(cornerRadius: 16).strokeBorder(
            isSelected ? Palette.teal : Palette.line, lineWidth: isSelected ? 1.5 : 1))
    }.buttonStyle(.plain).accessibilityLabel(title).accessibilityAddTraits(
      isSelected ? [.isSelected] : [])
  }
}

struct SectionTitle: View {
  let title: String
  let subtitle: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.system(.largeTitle, design: .serif, weight: .semibold)).foregroundStyle(
        Palette.ink)
      Text(subtitle).font(.subheadline).foregroundStyle(Palette.muted).fixedSize(
        horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
