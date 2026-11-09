import Darwin
import Foundation

func emit(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
guard CommandLine.arguments.count == 3 else { exit(2) }
let mode = CommandLine.arguments[1]
let parent = CommandLine.arguments[2]
do {
    if mode == "production-path" {
        emit(["directory": ControlNamespace.productionDirectory, "dispatchable": false])
    } else if mode == "namespace" {
        let namespace = try ControlNamespace.createUnderOwnedParent(parent)
        emit(["directory": namespace.directory, "dispatchable": false])
    } else if mode == "stop" {
        let namespace = try ControlNamespace.existingUnderOwnedParent(parent)
        guard try requestDiscoveredControlStop(namespace: namespace) else { throw ControlNamespaceError.unavailable }
        emit(["status": "revoked", "drained": false, "dispatchable": false])
    } else if mode == "try-lock" {
        let namespace = try ControlNamespace.existingUnderOwnedParent(parent)
        let lock = try ControlLock(directory: namespace.directory)
        lock.release(); emit(["status": "locked", "dispatchable": false])
    } else if mode == "owner" {
        let namespace = try ControlNamespace.createUnderOwnedParent(parent)
        let lock = try ControlLock(directory: namespace.directory)
        var random = SystemRandomNumberGenerator()
        let capability = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &random)) }.joined()
        let generation = "generation_" + UUID().uuidString
        let channel = try StopListener(control: lock, directory: namespace.directory, generation: generation, capability: capability)
        let discovery = try StopDiscovery(namespace: namespace, control: lock, generation: generation, capability: capability)
        defer { discovery.closeAfterDrain(); channel.closeAfterDrain(); lock.release() }
        guard fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) == 0 else { throw ControlNamespaceError.unavailable }
        emit(["status": "ready", "directory": namespace.directory, "dispatchable": false])
        var input = Data(); var drained = false
        while !drained {
            if try channel.service() { emit(["status": "revoked", "drained": false, "dispatchable": false]) }
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, 5) >= 0 else { throw ControlNamespaceError.unavailable }
            if descriptor.revents & Int16(POLLIN | POLLHUP) != 0 {
                var bytes = [UInt8](repeating: 0, count: 65)
                let count = read(STDIN_FILENO, &bytes, bytes.count)
                if count == 0 { channel.revokeFromOwner(); drained = true }
                else if count > 0 {
                    input.append(contentsOf: bytes.prefix(count))
                    guard input.count <= 64 else { throw ControlNamespaceError.unavailable }
                    while let newline = input.firstIndex(of: 10) {
                        let command = String(data: input[..<newline], encoding: .utf8)
                        input.removeSubrange(...newline)
                        if command == "drain" { channel.revokeFromOwner(); drained = true }
                        else if command == "status" { emit(["status": channel.revoked ? "revoked" : "active", "dispatchable": false]) }
                        else { throw ControlNamespaceError.unavailable }
                    }
                } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { throw ControlNamespaceError.unavailable }
            }
        }
        emit(["status": "drained", "drained": true, "dispatchable": false])
    } else { throw ControlNamespaceError.unavailable }
} catch ControlLockError.busy {
    emit(["status": "busy", "dispatchable": false]); exit(3)
} catch {
    FileHandle.standardError.write(Data("CONTROL_NAMESPACE_UNAVAILABLE\n".utf8)); exit(2)
}
