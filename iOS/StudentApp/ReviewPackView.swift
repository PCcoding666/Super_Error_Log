import SwiftUI

struct ReviewPackView: View {
  @Environment(StudyStore.self) private var store
  @State private var document: PDFDocumentItem?
  @State private var attempt: AttemptReference?

  private var ready: [StudyProblem] {
    store.state.allProblems.filter { $0.printable && store.state.drafts[$0.id]?.submittedAt != nil }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Eyebrow(text: "换张新纸，再试一次")
        SectionTitle(
          title: "回到纸上练一练。",
          subtitle: "选几道值得重做的题，给自己的思考留足空间。")
        HStack(spacing: 16) {
          Image(systemName: "doc.text").font(.system(size: 36, weight: .light)).foregroundStyle(
            Palette.teal)
          VStack(alignment: .leading, spacing: 5) {
            Text("已选 \(store.state.selectedIDs.count) 道题").font(.title3.weight(.semibold))
            Text("使用所选题目的印刷题干和已核对图示。\n缺少必要图示时会阻止生成。").font(
              .caption
            ).foregroundStyle(Palette.muted)
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(22).background(
          Palette.peach, in: RoundedRectangle(cornerRadius: 24))

        if ready.isEmpty {
          PaperCard {
            VStack(alignment: .leading, spacing: 12) {
              Label("先完成一次复盘", systemImage: "bubble.left.and.text.bubble.right")
                .font(.headline)
              Text(
                "在“复盘”中保存想法后，就可以在这里选择那道题。应用不会自动添加任何题目。"
              ).font(.subheadline).foregroundStyle(Palette.muted)
            }
          }
        } else {
          VStack(alignment: .leading, spacing: 12) {
            Text("由你选择，不是待办清单").font(.headline)
            ForEach(ready) { problem in
              Button {
                store.select(problem.id)
              } label: {
                HStack(alignment: .top, spacing: 12) {
                  Image(
                    systemName: store.state.selectedIDs.contains(problem.id)
                      ? "checkmark.circle.fill" : "circle"
                  )
                  .font(.title2).foregroundStyle(Palette.teal)
                  VStack(alignment: .leading, spacing: 6) {
                    Text(problem.title).font(.headline).foregroundStyle(Palette.ink)
                    Text("第 \(problem.number) 题 · \(problem.topic)").font(.caption).foregroundStyle(
                      Palette.muted)
                    Text(
                      store.state.drafts[problem.id]?.revisit == true
                        ? "你想再做一次" : "你选择这周先不做——仍然由你决定"
                    )
                    .font(.caption).foregroundStyle(Palette.teal)
                  }
                  Spacer(minLength: 0)
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                  .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
                  .overlay(
                    RoundedRectangle(cornerRadius: 18).strokeBorder(
                      store.state.selectedIDs.contains(problem.id) ? Palette.teal : Palette.line))
              }.buttonStyle(.plain).accessibilityIdentifier("select-\(problem.id)")
                .accessibilityAddTraits(
                  store.state.selectedIDs.contains(problem.id) ? [.isSelected] : [])
            }
          }
        }

        Button {
          document = store.createPack()
        } label: {
          HStack {
            Image(systemName: "doc.badge.plus")
            Text("生成练习包")
          }
        }.buttonStyle(PrimaryButton()).disabled(store.state.selectedIDs.isEmpty)
        Text(
          "先预览，再分享、保存或打印。\n保留创建时的题目快照，不放入原图、原作答案或订正记录。示例题会单独标明。"
        )
        .font(.caption).foregroundStyle(Palette.muted).frame(
          maxWidth: .infinity, alignment: .center
        ).multilineTextAlignment(.center)

        if !store.state.packs.isEmpty {
          Divider().overlay(Palette.line)
          Text("纸上练习后再回来记录").font(
            .system(.title2, design: .serif, weight: .semibold))
          ForEach(store.state.packs) { pack in
            PaperCard {
              VStack(alignment: .leading, spacing: 16) {
                HStack {
                  VStack(alignment: .leading, spacing: 4) {
                    Text("\(pack.problemIDs.count) 道题的练习包").font(.headline)
                    Text(pack.createdAt, style: .date).font(.caption).foregroundStyle(Palette.muted)
                  }
                  Spacer()
                  Button("打开 PDF") { document = store.openPack(pack) }.font(
                    .caption.weight(.semibold))
                }
                ForEach(pack.problemIDs, id: \.self) { id in
                  if let problem = pack.problemSnapshots.first(where: { $0.id == id }) {
                    VStack(alignment: .leading, spacing: 8) {
                      Text("第 \(problem.number) 题 · \(problem.title)").font(
                        .subheadline.weight(.medium))
                      if let outcome = pack.outcomes[id] {
                        Text(ReflectionOptions.displayTitle(for: outcome)).font(.subheadline).foregroundStyle(Palette.teal)
                        Text("学生自述 · 非 AI 评分").font(.caption2).foregroundStyle(
                          Palette.muted)
                      }
                      Button(
                        pack.outcomes[id] == nil ? "记录纸上练习结果" : "更新练习结果"
                      ) {
                        attempt = AttemptReference(
                          packID: pack.id, problem: problem, previous: pack.outcomes[id])
                      }.font(.subheadline.weight(.semibold)).padding(.vertical, 6)
                    }
                  }
                }
              }
            }
          }
        }
      }.padding(24)
    }.background(Palette.paper).navigationTitle("练习包").navigationBarTitleDisplayMode(
      .inline
    )
    .sheet(item: $document) { PDFPreview(item: $0) }
    .sheet(item: $attempt) { AttemptView(reference: $0) }
  }
}

struct AttemptReference: Identifiable {
  var id: String { "\(packID)-\(problem.id)" }
  let packID: UUID
  let problem: StudyProblem
  let previous: String?
}

struct AttemptView: View {
  let reference: AttemptReference
  @Environment(StudyStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var selected: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Eyebrow(text: "完成纸上练习后")
          SectionTitle(
            title: "这次做得怎么样？",
            subtitle:
              "第 \(reference.problem.number) 题 · \(reference.problem.title)。请在真正完成纸上练习后再记录。"
          )
          ForEach(ReflectionOptions.paperOutcomes, id: \.self) { option in
            ChoiceRow(title: ReflectionOptions.displayTitle(for: option), isSelected: selected == option) { selected = option }
          }
          Text(
            "这是你自己的学习记录，不是 AI 评分，也不代表已经掌握。需要再试一次，同样是有用的信息。"
          )
          .font(.subheadline).foregroundStyle(Palette.muted)
          Button("保存结果") {
            if let selected,
              store.recordOutcome(
                packID: reference.packID, problemID: reference.problem.id, outcome: selected)
            {
              dismiss()
            }
          }.buttonStyle(PrimaryButton()).disabled(selected == nil)
        }.padding(24)
      }.background(Palette.paper).navigationTitle("纸上练习结果").navigationBarTitleDisplayMode(
        .inline
      )
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("取消") { dismiss() } } }
    }.onAppear { selected = reference.previous }
  }
}
