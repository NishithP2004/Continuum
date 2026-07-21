import Foundation
import SwiftUI

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case unorderedList([String])
    case orderedList([String])
    case quote(String)
    case code(language: String?, text: String)
    case rule
}

enum ChatMarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { index += 1; continue }

            if line.hasPrefix("```") {
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var code: [String] = []
                while index < lines.count, !lines[index].hasPrefix("```") {
                    code.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: code.joined(separator: "\n")))
                continue
            }

            if let heading = heading(from: line) {
                blocks.append(heading)
                index += 1
                continue
            }

            if isRule(line) {
                blocks.append(.rule)
                index += 1
                continue
            }

            if line.hasPrefix("> ") {
                var values: [String] = []
                while index < lines.count, lines[index].hasPrefix("> ") {
                    values.append(String(lines[index].dropFirst(2)))
                    index += 1
                }
                blocks.append(.quote(values.joined(separator: "\n")))
                continue
            }

            if unorderedItem(line) != nil {
                var values: [String] = []
                while index < lines.count, let item = unorderedItem(lines[index]) {
                    values.append(item)
                    index += 1
                }
                blocks.append(.unorderedList(values))
                continue
            }

            if orderedItem(line) != nil {
                var values: [String] = []
                while index < lines.count, let item = orderedItem(lines[index]) {
                    values.append(item)
                    index += 1
                }
                blocks.append(.orderedList(values))
                continue
            }

            var paragraph = [line]
            index += 1
            while index < lines.count,
                  !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  !startsBlock(lines[index]) {
                paragraph.append(lines[index])
                index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    static func attributed(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var result = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        for run in result.runs {
            guard let link = run.link, !["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "") else { continue }
            result[run.range].link = nil
        }
        return result
    }

    private static func heading(from line: String) -> MarkdownBlock? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return .heading(level: hashes, text: String(line.dropFirst(hashes + 1)))
    }

    private static func unorderedItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) { return String(line.dropFirst(2)) }
        return nil
    }

    private static func orderedItem(_ line: String) -> String? {
        guard let range = line.range(of: #"^\d{1,4}\.\s+"#, options: .regularExpression) else { return nil }
        return String(line[range.upperBound...])
    }

    private static func isRule(_ line: String) -> Bool {
        ["---", "***", "___"].contains(line.trimmingCharacters(in: .whitespaces))
    }

    private static func startsBlock(_ line: String) -> Bool {
        line.hasPrefix("```") || heading(from: line) != nil || line.hasPrefix("> ") || unorderedItem(line) != nil || orderedItem(line) != nil || isRule(line)
    }
}

struct MarkdownMessageView: View {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(ChatMarkdownParser.parse(source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(ChatMarkdownParser.attributed(text))
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 3 : 0)
        case let .paragraph(text):
            Text(ChatMarkdownParser.attributed(text))
        case let .unorderedList(items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").foregroundStyle(.secondary)
                        Text(ChatMarkdownParser.attributed(item))
                    }
                }
            }
        case let .orderedList(items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(index + 1).").foregroundStyle(.secondary).monospacedDigit()
                        Text(ChatMarkdownParser.attributed(item))
                    }
                }
            }
        case let .quote(text):
            HStack(spacing: 9) {
                Rectangle().fill(.tertiary).frame(width: 3)
                Text(ChatMarkdownParser.attributed(text)).foregroundStyle(.secondary)
            }
        case let .code(language, text):
            VStack(alignment: .leading, spacing: 5) {
                if let language { Text(language).font(.caption2).foregroundStyle(.secondary) }
                ScrollView(.horizontal) {
                    Text(verbatim: text)
                        .font(.system(.callout, design: .monospaced))
                        .padding(9)
                }
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 7))
            }
        case .rule:
            Divider()
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title3.bold()
        case 2: .headline
        default: .callout.bold()
        }
    }
}
