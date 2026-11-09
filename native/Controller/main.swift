import Darwin
import Foundation

// Per-OS-user native controller. Holds the single control lock and the stop-only listener for its whole lifetime.
// It never dispatches input. The host must obtain "granted" before each single fixture action and send "end" after it.
// Stop (socket from CUStop, or host "revoke") is sticky: a revoked controller never grants again.

func emit(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
func usage() -> Never { FileHandle.standardError.write(Data("CONTROL_USAGE\n".utf8)); exit(2) }

let arguments = Array(CommandLine.arguments.dropFirst())
var stopOnly = false
var testParent: String?
switch arguments.count {
case 1 where arguments == ["--serve"]: break
case 1 where arguments == ["--stop"]: stopOnly = true
case 3 where arguments[0] == "--serve" && arguments[1] == "--test-parent": testParent = arguments[2]
case 3 where arguments[0] == "--stop" && arguments[1] == "--test-parent": stopOnly = true; testParent = arguments[2]
default: usage()
}

if stopOnly {
    do {
        let namespace = try testParent.map { try ControlNamespace.existingUnderOwnedParent($0) } ?? ControlNamespace.existingProduction()
        guard try requestDiscoveredControlStop(namespace: namespace) else { throw ControlNamespaceError.unavailable }
        emit(["status": "revoked", "drained": false, "dispatchable": false]); exit(0)
    } catch { FileHandle.standardError.write(Data("CONTROL_STOP_UNAVAILABLE\n".utf8)); exit(2) }
}

do {
    let namespace = try testParent.map { try ControlNamespace.createUnderOwnedParent($0) } ?? ControlNamespace.createProduction()
    let lock = try ControlLock(directory: namespace.directory)
    var random = SystemRandomNumberGenerator()
    let capability = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &random)) }.joined()
    let generation = "generation_" + UUID().uuidString
    let channel = try StopListener(control: lock, directory: namespace.directory, generation: generation, capability: capability)
    let discovery = try StopDiscovery(namespace: namespace, control: lock, generation: generation, capability: capability)
    defer { discovery.closeAfterDrain(); channel.closeAfterDrain(); lock.release() }
    guard fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) == 0 else { throw ControlNamespaceError.unavailable }
    emit(["status": "ready", "dispatchable": false])
    var input = Data(); var active = false; var finished = false; var announced = false
    while !finished {
        _ = try channel.service()
        try lock.requireOwnership()
        if channel.revoked && !announced { announced = true; emit(["status": "revoked", "active": active]) }
        var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        guard poll(&descriptor, 1, 5) >= 0 || errno == EINTR else { throw ControlNamespaceError.unavailable }
        guard descriptor.revents & Int16(POLLIN | POLLHUP) != 0 else { continue }
        var bytes = [UInt8](repeating: 0, count: 64)
        let count = read(STDIN_FILENO, &bytes, bytes.count)
        if count == 0 { channel.revokeFromOwner(); finished = true; continue }
        if count < 0 {
            if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { continue }
            throw ControlNamespaceError.unavailable
        }
        input.append(contentsOf: bytes.prefix(count))
        guard input.count <= 64 else { throw ControlNamespaceError.unavailable }
        while let newline = input.firstIndex(of: 10) {
            let command = String(data: input[..<newline], encoding: .utf8)
            input.removeSubrange(...newline)
            _ = try channel.service()
            switch command {
            case "begin":
                if channel.revoked { emit(["status": "revoked", "active": active]); announced = true }
                else if active { emit(["status": "busy"]) }
                else { try lock.requireOwnership(); active = true; emit(["status": "granted"]) }
            case "end": active = false; emit(["status": "idle"])
            case "revoke": channel.revokeFromOwner(); announced = true; emit(["status": "revoked", "active": active])
            case "status": emit(["status": channel.revoked ? "revoked" : active ? "active" : "idle"])
            default: throw ControlNamespaceError.unavailable
            }
        }
    }
    emit(["status": "drained", "drained": true])
} catch ControlLockError.busy {
    emit(["status": "busy"]); exit(3)
} catch {
    FileHandle.standardError.write(Data("CONTROL_UNAVAILABLE\n".utf8)); exit(2)
}
