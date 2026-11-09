import AppKit
import Foundation

let bundleIdentity = "dev.siyuqian.computer-use.fixture"

func fail(_ code: String, exitCode: Int32) -> Never {
    FileHandle.standardError.write(Data("\(code): Fixture operation stopped.\n".utf8))
    exit(exitCode)
}

struct Options {
    let selfTest: Bool
    let observeHost: Bool
    let stateDirectory: URL

    init(_ arguments: [String]) throws {
        var selfTest = false
        var observeHost = false
        var directory: String?
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--self-test":
                guard !selfTest else { throw FixtureError.invalidArguments }
                selfTest = true
            case "--observe-host":
                guard !observeHost else { throw FixtureError.invalidArguments }
                observeHost = true
            case "--state-dir":
                guard directory == nil, index + 1 < arguments.count else { throw FixtureError.invalidArguments }
                index += 1
                directory = arguments[index]
            default: throw FixtureError.invalidArguments
            }
            index += 1
        }
        guard let directory, directory.hasPrefix("/"), !(selfTest && observeHost) else { throw FixtureError.invalidArguments }
        self.selfTest = selfTest
        self.observeHost = observeHost
        stateDirectory = URL(fileURLWithPath: directory, isDirectory: true)
    }
}

@MainActor
func makeSecondaryStore(primary: FixtureStore) throws -> FixtureStore {
    let directory = primary.directory.appendingPathComponent("secondary", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    return try FixtureStore(directory: directory)
}

@MainActor
func selfTest(store: FixtureStore) throws {
    let secondaryStore = try makeSecondaryStore(primary: store)
    let fixture = FixtureWindow(store: store, title: "Computer Use Fixture — Primary") {
        fail("STATE_WRITE_FAILED", exitCode: 1)
    }
    let second = FixtureWindow(store: secondaryStore, title: "Computer Use Fixture — Secondary") {
        fail("STATE_WRITE_FAILED", exitCode: 1)
    }
    guard fixture.textField.accessibilityIdentifier() == "fixture.text",
          fixture.secureField.accessibilityIdentifier() == "fixture.secure",
          fixture.window !== second.window else { throw FixtureError.selfTestFailed }
    fixture.textField.stringValue = "fixture-edited"
    fixture.submit()
    guard store.state.text == "fixture-edited", store.state.submitCount == 1 else { throw FixtureError.selfTestFailed }
    second.textField.stringValue = "secondary-public-text"
    second.submit()
    guard store.state.text == "fixture-edited", store.state.submitCount == 1 else { throw FixtureError.selfTestFailed }
    fixture.secureField.stringValue = "fixture-password"
    let stateBytes = try Data(contentsOf: store.directory.appendingPathComponent("fixture-state.json"))
    guard !String(decoding: stateBytes, as: UTF8.self).contains("fixture-password") else { throw FixtureError.selfTestFailed }
    let previous = fixture.textField
    guard let oldWitness = previous.accessibilityHelp(), oldWitness.hasPrefix("fixture.element.element_"),
          oldWitness != second.textField.accessibilityHelp(), fixture.secureField.accessibilityHelp() == nil else { throw FixtureError.selfTestFailed }
    fixture.replaceTarget()
    guard previous !== fixture.textField, store.state.replacement == 1,
          let newWitness = fixture.textField.accessibilityHelp(), newWitness.hasPrefix("fixture.element.element_"),
          newWitness != oldWitness else { throw FixtureError.selfTestFailed }
    fixture.reorder()
    guard store.state.layout == "reordered", fixture.textField.accessibilityHelp() == newWitness else { throw FixtureError.selfTestFailed }
    fixture.saveCopy()
    let copy = try String(contentsOf: store.directory.appendingPathComponent("saved-copy.txt"), encoding: .utf8)
    guard copy == "fixture-edited" else { throw FixtureError.selfTestFailed }
    fixture.reset()
    let resetStack = fixture.textField.superview as? NSStackView
    guard store.state == FixtureState(), fixture.secureField.stringValue.isEmpty,
          resetStack?.arrangedSubviews.firstIndex(of: fixture.textField) == 1 else { throw FixtureError.selfTestFailed }
    fixture.delayedSubmit()
    fixture.reset()
    let deadline = Date().addingTimeInterval(0.4)
    while Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    guard store.state.submitCount == 0 else { throw FixtureError.selfTestFailed }
    fixture.delayedSubmit()
    let completionDeadline = Date().addingTimeInterval(0.4)
    while Date() < completionDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    guard store.state.submitCount == 1 else { throw FixtureError.selfTestFailed }
    fixture.reset()
    let report: [String: Any] = [
        "ok": true, "bundleId": bundleIdentity, "shownWindows": 0, "injectedInput": false,
        "checks": ["controls", "set_value", "submit", "secure_redaction", "replace", "reorder", "save_copy", "reset", "window_isolation", "delayed_cancel", "delayed_complete", "element_witness"],
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

@MainActor
final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    let store: FixtureStore
    let secondaryStore: FixtureStore
    var windows: [FixtureWindow] = []
    init(store: FixtureStore) throws {
        self.store = store
        self.secondaryStore = try makeSecondaryStore(primary: store)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        for (title, windowStore) in [("Primary", store), ("Secondary", secondaryStore)] {
            let fixture = FixtureWindow(store: windowStore, title: "Computer Use Fixture — \(title)") {
                fail("STATE_WRITE_FAILED", exitCode: 1)
            }
            windows.append(fixture)
            fixture.window.center()
            fixture.window.orderFrontRegardless()
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let options: Options
do { options = try Options(Array(CommandLine.arguments.dropFirst())) }
catch { fail("INVALID_ARGUMENTS", exitCode: 2) }

let store: FixtureStore
do { store = try FixtureStore(directory: options.stateDirectory) }
catch { fail("INVALID_STATE_DIRECTORY", exitCode: 2) }

let application = NSApplication.shared
if options.selfTest {
    application.setActivationPolicy(.prohibited)
    do { try selfTest(store: store) }
    catch { fail("SELF_TEST_FAILED", exitCode: 1) }
} else if options.observeHost {
    application.setActivationPolicy(.prohibited)
    do {
        let secondary = try makeSecondaryStore(primary: store)
        let windows = [
            FixtureWindow(store: store, title: "Computer Use Fixture — Primary") { fail("STATE_WRITE_FAILED", exitCode: 1) },
            FixtureWindow(store: secondary, title: "Computer Use Fixture — Secondary") { fail("STATE_WRITE_FAILED", exitCode: 1) },
        ]
        guard let identity = processIdentity(getpid()) else { fail("IDENTITY_UNAVAILABLE", exitCode: 1) }
        let report: [String: Any] = ["bundleId": bundleIdentity, "pid": identity.pid, "processStart": identity.start,
                                     "shownWindows": 0, "injectedInput": false,
                                     "windows": windows.enumerated().map { index, fixture in
                                         ["windowKey": index == 0 ? "primary" : "secondary", "windowId": fixture.window.windowNumber,
                                          "windowInstance": fixture.windowInstance] as [String: Any]
                                     }]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        DispatchQueue.global().async {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        withExtendedLifetime(windows) { application.run() }
    } catch { fail("OBSERVE_HOST_FAILED", exitCode: 1) }
} else {
    application.setActivationPolicy(.regular)
    do {
        let delegate = try ApplicationDelegate(store: store)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    } catch { fail("INVALID_STATE_DIRECTORY", exitCode: 2) }
}
