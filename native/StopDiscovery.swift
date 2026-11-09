import Darwin
import Foundation
import CoreFoundation

private func validDiscoveryId(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
        ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 || $0 == 45
    }
}
private func validDiscoveryCapability(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
}
private func safeDiscoveryFile(_ value: stat, links: nlink_t = 1) -> Bool {
    (value.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) && value.st_uid == geteuid() &&
        (value.st_mode & 0o7777) == 0o600 && value.st_nlink == links && value.st_size >= 0 && value.st_size <= 512
}
private func sameDiscoveryFile(_ first: stat, _ second: stat) -> Bool { first.st_dev == second.st_dev && first.st_ino == second.st_ino }
private func discoveryFrame(generation: String, capability: String) throws -> Data {
    guard validDiscoveryId(generation), validDiscoveryCapability(capability) else { throw ControlNamespaceError.unavailable }
    return try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "generation": generation, "capability": capability], options: [.sortedKeys]) + Data([10])
}

/// A protected file grants only the ability to revoke the current listener. It cannot grant or dispatch native work.
final class StopDiscovery {
    private let namespace: ControlNamespace
    private let control: ControlLock
    private let identity: stat
    private var published = false
    private let descriptor: Int32

    init(namespace: ControlNamespace, control: ControlLock, generation: String, capability: String) throws {
        let frame = try discoveryFrame(generation: generation, capability: capability)
        guard namespace.directory == control.namespaceDirectory else { throw ControlNamespaceError.unavailable }
        try namespace.requireWitness(); try control.requireOwnership()
        let directory = try namespace.duplicateDirectoryDescriptor()
        do {
            try Self.removeStale(directory: directory, namespace: namespace, control: control)
            let fd = openat(directory, "stop.endpoint.pending", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600))
            guard fd >= 0 else { throw ControlNamespaceError.unavailable }
            defer { close(fd) }
            var created = stat()
            guard fstat(fd, &created) == 0, safeDiscoveryFile(created) else { throw ControlNamespaceError.unavailable }
            var offset = 0
            while offset < frame.count {
                let written = frame.withUnsafeBytes { write(fd, $0.baseAddress!.advanced(by: offset), frame.count - offset) }
                guard written > 0 else { throw ControlNamespaceError.unavailable }
                offset += written
            }
            guard fsync(fd) == 0 else { throw ControlNamespaceError.unavailable }
            try namespace.requireWitness(); try control.requireOwnership()
            var entry = stat(); var current = stat()
            guard fstatat(directory, "stop.endpoint.pending", &entry, AT_SYMLINK_NOFOLLOW) == 0,
                  fstat(fd, &current) == 0, safeDiscoveryFile(current), safeDiscoveryFile(entry), sameDiscoveryFile(current, created),
                  sameDiscoveryFile(entry, created), current.st_size == frame.count else { throw ControlNamespaceError.unavailable }
            // linkat is no-replace: readers can only see the complete fsynced inode, never a partial final file.
            guard linkat(directory, "stop.endpoint.pending", directory, "stop.endpoint", 0) == 0,
                  unlinkat(directory, "stop.endpoint.pending", 0) == 0, fsync(directory) == 0 else { throw ControlNamespaceError.unavailable }
            var final = stat()
            guard fstatat(directory, "stop.endpoint", &final, AT_SYMLINK_NOFOLLOW) == 0,
                  safeDiscoveryFile(final), sameDiscoveryFile(final, created) else { throw ControlNamespaceError.unavailable }
            try namespace.requireWitness(); try control.requireOwnership()
            self.namespace = namespace; self.control = control; descriptor = directory; identity = final
            published = true
        } catch { close(directory); throw ControlNamespaceError.unavailable }
    }

    /// The caller must revoke and drain first. Remove only this object's exact file; never a replacement or lock inode.
    func closeAfterDrain() {
        guard published else { return }
        published = false
        guard (try? namespace.requireWitness()) != nil, (try? control.requireOwnership()) != nil else { return }
        var current = stat()
        if fstatat(descriptor, "stop.endpoint", &current, AT_SYMLINK_NOFOLLOW) == 0,
           safeDiscoveryFile(current), sameDiscoveryFile(current, identity) { _ = unlinkat(descriptor, "stop.endpoint", 0) }
    }
    deinit { closeAfterDrain(); close(descriptor) }

    private static func removeStale(directory: Int32, namespace: ControlNamespace, control: ControlLock) throws {
        var endpoint = stat(); var pending = stat()
        let hasEndpoint = fstatat(directory, "stop.endpoint", &endpoint, AT_SYMLINK_NOFOLLOW) == 0
        if !hasEndpoint && errno != ENOENT { throw ControlNamespaceError.unavailable }
        let hasPending = fstatat(directory, "stop.endpoint.pending", &pending, AT_SYMLINK_NOFOLLOW) == 0
        if !hasPending && errno != ENOENT { throw ControlNamespaceError.unavailable }
        let linkedPair = hasEndpoint && hasPending && sameDiscoveryFile(endpoint, pending)
        if hasEndpoint && !safeDiscoveryFile(endpoint, links: linkedPair ? 2 : 1) { throw ControlNamespaceError.unavailable }
        if hasPending && !safeDiscoveryFile(pending, links: linkedPair ? 2 : 1) { throw ControlNamespaceError.unavailable }
        try namespace.requireWitness(); try control.requireOwnership()
        // Partial pending and malformed final files are safe to remove only after the old lock owner has ended.
        if hasPending && unlinkat(directory, "stop.endpoint.pending", 0) != 0 { throw ControlNamespaceError.unavailable }
        if hasEndpoint && unlinkat(directory, "stop.endpoint", 0) != 0 { throw ControlNamespaceError.unavailable }
    }
}

/// Host/local stop route only. Discovery errors do not alter or repair files, and no control lock is acquired to send stop.
func requestDiscoveredControlStop(namespace: ControlNamespace) throws -> Bool {
    try namespace.requireWitness()
    let path = namespace.directory + "/stop.endpoint"
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw ControlNamespaceError.unavailable }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, safeDiscoveryFile(info) else { throw ControlNamespaceError.unavailable }
    var bytes = [UInt8](repeating: 0, count: 513)
    let count = read(fd, &bytes, bytes.count)
    guard count > 0, count <= 512 else { throw ControlNamespaceError.unavailable }
    var eof: UInt8 = 0
    guard read(fd, &eof, 1) == 0 else { throw ControlNamespaceError.unavailable }
    let frame = Data(bytes.prefix(count))
    guard frame.last == 10,
          let fields = try JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any],
          Set(fields.keys) == Set(["protocolVersion", "generation", "capability"]),
          let version = fields["protocolVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
          let generation = fields["generation"] as? String, let capability = fields["capability"] as? String,
          frame == (try discoveryFrame(generation: generation, capability: capability)) else { throw ControlNamespaceError.unavailable }
    var entry = stat(); var after = stat()
    guard lstat(path, &entry) == 0, fstat(fd, &after) == 0, safeDiscoveryFile(entry), safeDiscoveryFile(after),
          sameDiscoveryFile(entry, info), sameDiscoveryFile(after, info), after.st_size == count else { throw ControlNamespaceError.unavailable }
    try namespace.requireWitness()
    return try requestControlStop(directory: namespace.directory, generation: generation, capability: capability)
}
