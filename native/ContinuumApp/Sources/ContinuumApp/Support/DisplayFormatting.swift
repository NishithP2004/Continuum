import Foundation

enum DisplayFormatting {
    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601 = ISO8601DateFormatter()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    static func relativeTimestamp(_ value: String) -> String {
        guard !value.isEmpty else { return "Unknown time" }
        let date = iso8601WithFractionalSeconds.date(from: value) ?? iso8601.date(from: value)
        guard let date else { return value }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    static func percentage(_ value: Double) -> String {
        "\(Int((min(max(value, 0), 1) * 100).rounded()))%"
    }
}

extension String {
    func truncatedForMenu(limit: Int = 30) -> String {
        guard count > limit, limit > 3 else { return self }
        return String(prefix(limit - 3)) + "..."
    }
}
