import AppKit

@MainActor
final class FixtureWindow: NSObject, NSTextFieldDelegate {
    let window: NSWindow
    let windowInstance = "window_\(UUID().uuidString)"
    private(set) var textField = NSTextField(string: "")
    let secureField = NSSecureTextField(string: "")
    private let store: FixtureStore
    private let stack = NSStackView()
    private let status = NSTextField(labelWithString: "Ready")
    private let onFailure: () -> Void
    private var pendingSubmit: Task<Void, Never>?

    init(store: FixtureStore, title: String, onFailure: @escaping () -> Void) {
        self.store = store
        self.onFailure = onFailure
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 440),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        super.init()
        let key = title.hasSuffix("Secondary") ? "secondary" : "primary"
        window.setAccessibilityIdentifier("fixture.window.\(key).\(window.windowNumber).\(windowInstance)")
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let content = window.contentView else { return }
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
        ])
        let warning = NSTextField(wrappingLabelWithString: "Public test data only. No real accounts, passwords, or documents.")
        stack.addArrangedSubview(warning)
        configureTextField(textField)
        stack.addArrangedSubview(textField)
        secureField.placeholderString = "Simulated secure field. Do not enter real credentials."
        secureField.setAccessibilityIdentifier("fixture.secure")
        secureField.setAccessibilityLabel("Simulated password")
        secureField.widthAnchor.constraint(equalToConstant: 460).isActive = true
        stack.addArrangedSubview(secureField)
        addButton("Submit test value", id: "fixture.submit", action: #selector(submit))
        addButton("Replace text target", id: "fixture.replace", action: #selector(replaceTarget))
        addButton("Reorder controls", id: "fixture.reorder", action: #selector(reorder))
        addButton("Delayed test effect", id: "fixture.delayed", action: #selector(delayedSubmit))
        addButton("Save test copy", id: "fixture.save", action: #selector(saveCopy))
        addButton("Reset fixture", id: "fixture.reset", action: #selector(reset))
        status.setAccessibilityIdentifier("fixture.status")
        stack.addArrangedSubview(status)
    }

    private func configureTextField(_ field: NSTextField) {
        field.placeholderString = "Public fixture text"
        field.setAccessibilityIdentifier("fixture.text")
        field.setAccessibilityHelp("fixture.element.element_\(UUID().uuidString)")
        field.setAccessibilityLabel("Fixture text")
        field.delegate = self
        field.widthAnchor.constraint(equalToConstant: 460).isActive = true
    }

    private func addButton(_ title: String, id: String, action: Selector) {
        let button = NSButton(title: title, target: self, action: action)
        button.setAccessibilityIdentifier(id)
        button.setAccessibilityHelp("fixture.element.element_\(UUID().uuidString)")
        stack.addArrangedSubview(button)
    }

    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSTextField === textField else { return }
        mutate { $0.text = textField.stringValue }
    }

    @objc func submit() {
        mutate { $0.text = textField.stringValue; $0.submitCount += 1 }
        status.stringValue = "Submitted public test value"
    }

    @objc func replaceTarget() {
        let old = textField
        let replacement = NSTextField(string: old.stringValue)
        configureTextField(replacement)
        let index = stack.arrangedSubviews.firstIndex(of: old) ?? 1
        stack.removeArrangedSubview(old)
        old.removeFromSuperview()
        textField = replacement
        stack.insertArrangedSubview(replacement, at: index)
        mutate { $0.replacement += 1 }
    }

    @objc func reorder() {
        stack.removeArrangedSubview(textField)
        textField.removeFromSuperview()
        let moved = store.state.layout == "normal"
        stack.insertArrangedSubview(textField, at: moved ? stack.arrangedSubviews.count - 1 : 1)
        mutate { $0.layout = moved ? "reordered" : "normal" }
    }

    @objc func delayedSubmit() {
        pendingSubmit?.cancel()
        let generation = store.state.revision
        pendingSubmit = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) }
            catch { return }
            guard !Task.isCancelled, let self, self.store.state.revision == generation else { return }
            self.submit()
        }
    }

    @objc func saveCopy() {
        do {
            try store.update { $0.text = textField.stringValue }
            try store.saveCopy()
            status.stringValue = "Saved public test copy"
        } catch { onFailure() }
    }

    @objc func reset() {
        pendingSubmit?.cancel()
        pendingSubmit = nil
        do {
            try store.reset()
            stack.removeArrangedSubview(textField)
            textField.removeFromSuperview()
            stack.insertArrangedSubview(textField, at: 1)
            textField.stringValue = ""
            secureField.stringValue = ""
            status.stringValue = "Ready"
        } catch { onFailure() }
    }

    private func mutate(_ edit: (inout FixtureState) -> Void) {
        do { try store.update(edit) } catch { onFailure() }
    }
}
