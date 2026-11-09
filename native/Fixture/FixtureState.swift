import Foundation

struct FixtureState: Codable, Equatable {
    var text = ""
    var submitCount = 0
    var revision = 0
    var layout = "normal"
    var replacement = 0
}

enum FixtureError: Error { case invalidArguments, invalidStateDirectory, stateWriteFailed, selfTestFailed }

/// Records public fixture data only. Never pass private documents or real credentials.
final class FixtureStore {
    let directory: URL
    private(set) var state = FixtureState()

    init(directory: URL) throws {
        let manager = FileManager.default
        let canonical = directory.standardizedFileURL.resolvingSymlinksInPath()
        guard directory.path.hasPrefix("/"), canonical.path == directory.standardizedFileURL.path else {
            throw FixtureError.invalidStateDirectory
        }
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: canonical.path, isDirectory: &isDirectory), isDirectory.boolValue,
              try manager.contentsOfDirectory(atPath: canonical.path).isEmpty else {
            throw FixtureError.invalidStateDirectory
        }
        self.directory = canonical
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: canonical.path)
        try persist()
    }

    func update(_ edit: (inout FixtureState) -> Void) throws {
        var next = state
        edit(&next)
        next.revision += 1
        try write(next, to: directory.appendingPathComponent("fixture-state.json"))
        state = next
    }

    func reset() throws {
        let next = FixtureState()
        try write(next, to: directory.appendingPathComponent("fixture-state.json"))
        state = next
    }

    func saveCopy() throws {
        let target = directory.appendingPathComponent("saved-copy.txt")
        try validateOwnedFile(target)
        try Data(state.text.utf8).write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    private func persist() throws {
        try write(state, to: directory.appendingPathComponent("fixture-state.json"))
    }

    private func write(_ value: FixtureState, to target: URL) throws {
        try validateOwnedFile(target)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(value).write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    private func validateOwnedFile(_ target: URL) throws {
        guard target.deletingLastPathComponent().standardizedFileURL == directory,
              target.resolvingSymlinksInPath().standardizedFileURL == target.standardizedFileURL,
              directory.resolvingSymlinksInPath() == directory else {
            throw FixtureError.stateWriteFailed
        }
    }
}
