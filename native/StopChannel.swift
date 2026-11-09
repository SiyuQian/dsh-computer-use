import Darwin
import Foundation
import CoreFoundation

// Only stop is exposed. These helpers do not grant, resume, or dispatch native work.
enum StopChannelError: Error { case unavailable }

private func stopInstant() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
private func validStopId(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
        ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 || $0 == 45
    }
}
private func capabilityBytes(_ value: String) -> [UInt8]? {
    let bytes = Array(value.utf8)
    guard bytes.count == 64, bytes.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }) else { return nil }
    return bytes
}
private func sameCapability(_ first: [UInt8], _ second: [UInt8]) -> Bool {
    guard first.count == second.count else { return false }
    var different: UInt8 = 0
    for index in first.indices { different |= first[index] ^ second[index] }
    return different == 0
}
private func stopAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw StopChannelError.unavailable }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in destination.copyBytes(from: bytes) }
    return address
}
private func safeSocket() throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StopChannelError.unavailable }
    var enabled: Int32 = 1
    guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0,
          fcntl(fd, F_SETFL, O_NONBLOCK) == 0,
          setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
        close(fd); throw StopChannelError.unavailable
    }
    return fd
}
private func samePeer(_ fd: Int32) -> Bool {
    var uid: uid_t = 0
    var gid: gid_t = 0
    return getpeereid(fd, &uid, &gid) == 0 && uid == geteuid()
}
private func stopReply(_ revoked: Bool) -> Data {
    Data((revoked ? "{\"status\":\"revoked\",\"drained\":false,\"dispatchable\":false}\n" : "{\"status\":\"denied\",\"dispatchable\":false}\n").utf8)
}

/// Same-UID, private-capability stop listener. Caller must own and retain ControlLock through final drain.
/// No input executor or production namespace is created by this object.
final class StopListener {
    private struct Connection { let fd: Int32; let deadline: UInt64; var bytes = Data() }
    private let control: ControlLock
    private let path: String
    private let generation: String
    private let capability: [UInt8]
    private var listener: Int32 = -1
    private var socketIdentity: stat?
    private var connections: [Int32: Connection] = [:]
    private(set) var revoked = false

    init(control: ControlLock, directory: String, generation: String, capability: String) throws {
        guard directory == control.namespaceDirectory, validStopId(generation), let secret = capabilityBytes(capability) else { throw StopChannelError.unavailable }
        self.control = control
        path = directory + "/stop.sock"
        self.generation = generation
        self.capability = secret
        try control.requireOwnership()
        var old = stat()
        if lstat(path, &old) == 0 {
            guard old.st_uid == geteuid(), (old.st_mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK),
                  old.st_nlink == 1, (old.st_mode & 0o7777) == 0o600 else { throw StopChannelError.unavailable }
            try control.requireOwnership()
            guard unlink(path) == 0 else { throw StopChannelError.unavailable }
        } else if errno != ENOENT { throw StopChannelError.unavailable }
        listener = try safeSocket()
        var address = try stopAddress(path)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { throw StopChannelError.unavailable }
        var created = stat()
        guard lstat(path, &created) == 0 else { throw StopChannelError.unavailable }
        socketIdentity = created
        guard chmod(path, 0o600) == 0, listen(listener, 8) == 0 else { throw StopChannelError.unavailable }
        try control.requireOwnership()
    }

    /// Bounded nonblocking service step. A partial/slow peer cannot block the next accepted stop.
    func service() throws -> Bool {
        try control.requireOwnership()
        let before = revoked
        for (fd, connection) in connections where stopInstant() >= connection.deadline { finish(fd, authorized: false) }
        for _ in 0..<8 {
            let fd = accept(listener, nil, nil)
            if fd < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { break }
                throw StopChannelError.unavailable
            }
            var enabled: Int32 = 1
            if connections.count >= 8 || !samePeer(fd) ||
                fcntl(fd, F_SETFD, FD_CLOEXEC) != 0 || fcntl(fd, F_SETFL, O_NONBLOCK) != 0 ||
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) != 0 {
                close(fd); continue
            }
            connections[fd] = Connection(fd: fd, deadline: stopInstant() + 250_000_000)
        }
        for fd in Array(connections.keys) {
            guard var connection = connections[fd] else { continue }
            if stopInstant() >= connection.deadline { finish(fd, authorized: false); continue }
            var buffer = [UInt8](repeating: 0, count: 513)
            let count = recv(fd, &buffer, buffer.count, 0)
            if count > 0 {
                connection.bytes.append(contentsOf: buffer.prefix(count))
                if connection.bytes.count > 512 { finish(fd, authorized: false) }
                else { connections[fd] = connection }
            } else if count == 0 {
                let authorized = accepts(connection.bytes)
                if authorized { revoked = true }
                finish(fd, authorized: authorized)
            } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { finish(fd, authorized: false) }
        }
        return !before && revoked
    }

    /// Sticky revocation can only reduce authority. Acknowledgement never means native work has drained.
    func revokeFromOwner() { revoked = true }

    func closeAfterDrain() {
        for fd in Array(connections.keys) { close(fd) }
        connections.removeAll()
        if listener >= 0 { close(listener); listener = -1 }
        if let expected = socketIdentity {
            var current = stat()
            if lstat(path, &current) == 0, current.st_dev == expected.st_dev, current.st_ino == expected.st_ino,
               (current.st_mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK), current.st_uid == geteuid() {
                _ = unlink(path)
            }
            socketIdentity = nil
        }
    }
    deinit { closeAfterDrain() }

    private func accepts(_ frame: Data) -> Bool {
        guard frame.count <= 512, frame.last == 10, frame.dropLast().allSatisfy({ $0 != 10 }),
              let object = try? JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any],
              Set(object.keys) == Set(["protocolVersion", "command", "generation", "capability"]),
              let version = object["protocolVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              object["command"] as? String == "stop", object["generation"] as? String == generation,
              let text = object["capability"] as? String, let supplied = capabilityBytes(text),
              let canonical = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              canonical == frame.dropLast() else { return false }
        return sameCapability(capability, supplied)
    }
    private func finish(_ fd: Int32, authorized: Bool) {
        connections.removeValue(forKey: fd)
        let reply = stopReply(authorized)
        _ = reply.withUnsafeBytes { send(fd, $0.baseAddress!, $0.count, 0) }
        close(fd)
    }
}

/// Closed stop-only client; its caller supplies the capability via a private host channel, never argv or logs.
func requestControlStop(directory: String, generation: String, capability: String) throws -> Bool {
    guard validStopId(generation), capabilityBytes(capability) != nil, directory.hasPrefix("/"), !directory.contains("\0"),
          let resolved = realpath(directory, nil) else { throw StopChannelError.unavailable }
    let canonical = String(cString: resolved)
    free(resolved)
    var parent = stat()
    guard canonical == directory, lstat(directory, &parent) == 0, parent.st_uid == geteuid(),
          (parent.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR), (parent.st_mode & 0o7777) == 0o700 else { throw StopChannelError.unavailable }
    let path = directory + "/stop.sock"
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFSOCK), info.st_uid == geteuid(),
          (info.st_mode & 0o7777) == 0o600 else { throw StopChannelError.unavailable }
    let fd = try safeSocket()
    defer { close(fd) }
    var address = try stopAddress(path)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 || errno == EINPROGRESS else { throw StopChannelError.unavailable }
    var pollfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pollfd, 1, 1000) > 0, samePeer(fd) else { throw StopChannelError.unavailable }
    let data = try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "command": "stop", "generation": generation, "capability": capability], options: [.sortedKeys]) + Data([10])
    let sent = data.withUnsafeBytes { send(fd, $0.baseAddress!, $0.count, 0) }
    guard sent == data.count, shutdown(fd, SHUT_WR) == 0 else { throw StopChannelError.unavailable }
    let deadline = stopInstant() + 1_000_000_000
    var reply = Data()
    while stopInstant() < deadline {
        var descriptor = Darwin.pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&descriptor, 1, 50) >= 0 else { throw StopChannelError.unavailable }
        var bytes = [UInt8](repeating: 0, count: 129)
        let count = recv(fd, &bytes, bytes.count, 0)
        if count == 0 { return reply == stopReply(true) }
        if count > 0 {
            reply.append(contentsOf: bytes.prefix(count))
            guard reply.count <= 128 else { throw StopChannelError.unavailable }
        } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { throw StopChannelError.unavailable }
    }
    throw StopChannelError.unavailable
}
