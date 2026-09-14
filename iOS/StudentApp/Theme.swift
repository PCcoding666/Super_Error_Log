import SwiftUI

enum Palette {
  static let paper = Color(red: 0.97, green: 0.96, blue: 0.93)
  static let ink = Color(red: 0.12, green: 0.20, blue: 0.22)
  static let muted = Color(red: 0.36, green: 0.42, blue: 0.43)
  static let teal = Color(red: 0.12, green: 0.38, blue: 0.36)
  static let mint = Color(red: 0.87, green: 0.92, blue: 0.87)
  static let peach = Color(red: 0.97, green: 0.87, blue: 0.78)
  static let line = Color(red: 0.86, green: 0.88, blue: 0.84)
}

struct PrimaryButton: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 17)
      .foregroundStyle(.white).background(
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
      .background(.white, in: RoundedRectangle(cornerRadius: 24))
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
        .background(isSelected ? Palette.mint : .white, in: RoundedRectangle(cornerRadius: 16))
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
