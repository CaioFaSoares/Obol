import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ObolCore
import ObolNativeRuntime

// MARK: - Surfaces

/// The single place this folder converts a UIKit semantic surface into a
/// SwiftUI color. Section cards sit inside list rows, so they use the raised
/// grouped surface and never re-declare their own color.
enum SettingsSurface {
    static let raised = Color(uiColor: .tertiarySystemGroupedBackground)
}

// MARK: - Readable JSON

/// Display-only rendering of `JSONValue` for operation, conflict and
/// before-snapshot inspection.
///
/// Canonical bytes stay with `CanonicalJSON` (the sync writer). This formatter
/// only adds indentation and always delegates scalar spelling and string
/// escaping to that canonical writer, so the display never invents a second
/// JSON dialect.
enum JSONPresenting {
    static func readable(_ value: JSONValue) -> String {
        var output = ""
        append(value, to: &output, indent: "")
        return output
    }

    private static func append(_ value: JSONValue, to output: inout String, indent: String) {
        switch value {
        case .array(let items):
            guard !items.isEmpty else {
                output += "[]"
                return
            }
            output += "[\n"
            for (index, item) in items.enumerated() {
                output += indent + "  "
                append(item, to: &output, indent: indent + "  ")
                output += index == items.count - 1 ? "\n" : ",\n"
            }
            output += indent + "]"
        case .object(let entries):
            guard !entries.isEmpty else {
                output += "{}"
                return
            }
            let keys = entries.keys.sorted()
            output += "{\n"
            for (index, key) in keys.enumerated() {
                output += indent + "  " + CanonicalJSON.string(.string(key)) + ": "
                append(entries[key] ?? .null, to: &output, indent: indent + "  ")
                output += index == keys.count - 1 ? "\n" : ",\n"
            }
            output += indent + "}"
        default:
            output += CanonicalJSON.string(value)
        }
    }
}

/// Collapsible JSON payload. The readable string is only produced after the
/// user expands the block, so a 64 KiB payload never costs layout work while
/// the row is collapsed. The content is never truncated.
struct JSONBlock: View {
    let title: String
    let value: JSONValue

    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            if isExpanded {
                Text(verbatim: JSONPresenting.readable(value))
                    .font(.system(.caption, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        } label: {
            Text(title)
                .font(.subheadline)
        }
    }
}

// MARK: - Export document

/// `FileDocument` over the token-free snapshot bytes produced by
/// `AppState.exportSnapshot()`. It never re-serializes financial state.
struct JSONExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    static var writableContentTypes: [UTType] { [.json] }

    var data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// MARK: - Share sheet

/// UIKit share entry for an already written export file. The file itself is
/// created by the caller from `AppState.exportSnapshot()` bytes.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Inline notices

/// One visible error, local to the surface that produced it. It is a real row
/// instead of a transient banner, so a failure is never hidden behind a
/// scroll position and stays readable with VoiceOver and large type.
struct ErrorNotice: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.octagon.fill")
                    .foregroundStyle(.red)
                    .accessibilityHidden(true)
                Text(message)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Dismiss", role: .cancel, action: onDismiss)
                .font(.footnote.weight(.medium))
                .frame(minHeight: 44, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Error"))
    }
}

/// One non-error informational sentence. The icon and the text both carry the
/// meaning; no state is communicated by color alone.
struct NoticeText: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "info.circle")
                .accessibilityHidden(true)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

/// Pinned bottom feedback for a whole screen. It reserves its own space, so a
/// failure is visible from every scroll position instead of being hidden at
/// the top of a long list. Both values are cleared by the owning view; nothing
/// is routed through the root `lastError` slot.
struct FeedbackInset: View {
    let error: String?
    let notice: String?
    let onDismissError: () -> Void
    let onDismissNotice: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error {
                ErrorNotice(message: error, onDismiss: onDismissError)
            }
            if let notice {
                HStack(alignment: .top, spacing: 8) {
                    NoticeText(message: notice)
                    Spacer(minLength: 0)
                    Button("Dismiss", role: .cancel, action: onDismissNotice)
                        .font(.footnote.weight(.medium))
                        .frame(minHeight: 44, alignment: .trailing)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
    }
}
