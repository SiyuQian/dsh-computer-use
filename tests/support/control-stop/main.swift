import Darwin
import Foundation

func emit(_ status: String, drained: Bool? = nil) {
    var fields: [String: Any] = ["status": status, "dispatchable": false]
    if let drained { fields["drained"] = drained }
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
func privateCapability() throws -> String {
    guard fcntl(3, F_SETFL, O_NONBLOCK) == 0 else { throw StopChannelError.unavailable }
    defer { close(3) }
    var result = Data()
    let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
        var descriptor = pollfd(fd: 3, events: Int16(POLLIN), revents: 0)
        guard poll(&descriptor, 1, 50) >= 0 else { throw StopChannelError.unavailable }
        var bytes = [UInt8](repeating: 0, count: 66)
        let count = read(3, &bytes, bytes.count)
        if count > 0 {
            result.append(contentsOf: bytes.prefix(count))
            guard result.count <= 65 else { throw StopChannelError.unavailable }
        } else if count == 0 {
            guard result.count == 65, result.last == 10, let text = String(data: result.dropLast(), encoding: .utf8) else { throw StopChannelError.unavailable }
            return text
        } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { throw StopChannelError.unavailable }
    }
    throw StopChannelError.unavailable
}
guard CommandLine.arguments.count >= 3 else { exit(2) }
let mode = CommandLine.arguments[1]
let directory = CommandLine.arguments[2]
do {
    if mode == "--test-try-lock", CommandLine.arguments.count == 3 {
        do { let lock = try ControlLock(directory: directory); emit("locked"); lock.release() }
        catch ControlLockError.busy { emit("busy"); exit(3) }
    } else if mode == "--test-mismatched-listener", CommandLine.arguments.count == 4 {
        let capability = try privateCapability()
        let lock = try ControlLock(directory: directory)
        let channel = try StopListener(control: lock, directory: CommandLine.arguments[3], generation: "generation_fixture", capability: capability)
        emit("ready")
        channel.closeAfterDrain(); lock.release()
    } else if mode == "--test-stop", CommandLine.arguments.count == 4 {
        let capability = try privateCapability()
        let revoked = try requestControlStop(directory: directory, generation: CommandLine.arguments[3], capability: capability)
        emit(revoked ? "revoked" : "denied", drained: revoked ? false : nil)
        if !revoked { exit(2) }
    } else if ["--test-owner", "--test-paused-owner"].contains(mode), CommandLine.arguments.count == 4 {
        let capability = try privateCapability()
        let lock = try ControlLock(directory: directory)
        let channel = try StopListener(control: lock, directory: directory, generation: CommandLine.arguments[3], capability: capability)
        defer { channel.closeAfterDrain(); lock.release() }
        guard fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) == 0 else { throw StopChannelError.unavailable }
        emit("ready")
        var input = Data()
        var drained = false
        var servicing = mode != "--test-paused-owner"
        while !drained {
            if servicing, try channel.service() { emit("revoked", drained: false) }
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, 5) >= 0 else { throw StopChannelError.unavailable }
            if descriptor.revents & Int16(POLLIN | POLLHUP) != 0 {
                var bytes = [UInt8](repeating: 0, count: 65)
                let count = read(STDIN_FILENO, &bytes, bytes.count)
                if count == 0 { channel.revokeFromOwner(); drained = true }
                else if count > 0 {
                    input.append(contentsOf: bytes.prefix(count))
                    guard input.count <= 64 else { throw StopChannelError.unavailable }
                    while let newline = input.firstIndex(of: 10) {
                        let command = String(data: input[..<newline], encoding: .utf8)
                        input.removeSubrange(...newline)
                        if command == "drain" { channel.revokeFromOwner(); drained = true }
                        else if command == "status" { emit(channel.revoked ? "revoked" : "active") }
                        else if command == "service", mode == "--test-paused-owner" { servicing = true }
                        else if command == "step", mode == "--test-paused-owner" {
                            if try channel.service() { emit("revoked", drained: false) }
                            emit("stepped")
                        }
                        else { throw StopChannelError.unavailable }
                    }
                } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { throw StopChannelError.unavailable }
            }
        }
        emit("drained", drained: true)
    } else { throw StopChannelError.unavailable }
} catch {
    FileHandle.standardError.write(Data("CONTROL_STOP_UNAVAILABLE\n".utf8)); exit(2)
}
