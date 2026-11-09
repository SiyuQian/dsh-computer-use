import Darwin
import Foundation

enum ControlNamespaceError: Error { case unavailable }

/// Trusted filesystem namespace, not a native control grant. Production selection never reads environment or profile settings.
final class ControlNamespace {
    static var productionDirectory: String { "/private/tmp/dsh-computer-use-\(geteuid())" }
    let directory: String
    private let parentPath: String
    private let parentFD: Int32
    private let directoryFD: Int32
    private let parentIdentity: stat
    private let directoryIdentity: stat
    private let systemParent: Bool
    private let leaf: String

    static func createProduction() throws -> ControlNamespace {
        try ControlNamespace(parent: "/private/tmp", systemParent: true, create: true)
    }
    static func existingProduction() throws -> ControlNamespace {
        try ControlNamespace(parent: "/private/tmp", systemParent: true, create: false)
    }
    /// Host-only reusable primitive for self-owned isolated parents. The stop CLI never selects this route.
    static func createUnderOwnedParent(_ parent: String) throws -> ControlNamespace {
        try ControlNamespace(parent: parent, systemParent: false, create: true)
    }
    static func existingUnderOwnedParent(_ parent: String) throws -> ControlNamespace {
        try ControlNamespace(parent: parent, systemParent: false, create: false)
    }

    private init(parent: String, systemParent: Bool, create: Bool) throws {
        guard geteuid() != 0, getuid() == geteuid(), parent.hasPrefix("/"), !parent.contains("\0"),
              let resolved = realpath(parent, nil) else { throw ControlNamespaceError.unavailable }
        let canonical = String(cString: resolved); free(resolved)
        guard canonical == parent else { throw ControlNamespaceError.unavailable }
        let parentFile = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parentFile >= 0 else { throw ControlNamespaceError.unavailable }
        var parentInfo = stat()
        guard fstat(parentFile, &parentInfo) == 0, Self.validParent(parentInfo, system: systemParent) else {
            close(parentFile); throw ControlNamespaceError.unavailable
        }
        let name = "dsh-computer-use-\(geteuid())"
        if create, mkdirat(parentFile, name, mode_t(0o700)) != 0, errno != EEXIST {
            close(parentFile); throw ControlNamespaceError.unavailable
        }
        let child = openat(parentFile, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { close(parentFile); throw ControlNamespaceError.unavailable }
        var childInfo = stat()
        guard fstat(child, &childInfo) == 0, Self.validLeaf(childInfo) else {
            close(child); close(parentFile); throw ControlNamespaceError.unavailable
        }
        parentPath = parent; parentFD = parentFile; directoryFD = child
        directory = parent + "/" + name; leaf = name
        parentIdentity = parentInfo; directoryIdentity = childInfo; self.systemParent = systemParent
        try requireWitness()
    }

    /// Validate path and descriptor witnesses before publication, reads, or removal of owned entries.
    func requireWitness() throws {
        var parent = stat(); var parentDescriptor = stat(); var child = stat(); var descriptor = stat()
        guard lstat(parentPath, &parent) == 0, Self.validParent(parent, system: systemParent), Self.same(parent, parentIdentity),
              fstat(parentFD, &parentDescriptor) == 0, Self.same(parentDescriptor, parentIdentity),
              fstatat(parentFD, leaf, &child, AT_SYMLINK_NOFOLLOW) == 0, Self.validLeaf(child), Self.same(child, directoryIdentity),
              fstat(directoryFD, &descriptor) == 0, Self.validLeaf(descriptor), Self.same(descriptor, directoryIdentity) else { throw ControlNamespaceError.unavailable }
    }
    /// Duplicate the witnessed descriptor instead of reopening a replaceable path. The caller owns the returned FD.
    func duplicateDirectoryDescriptor() throws -> Int32 {
        try requireWitness()
        let duplicate = fcntl(directoryFD, F_DUPFD_CLOEXEC, 0)
        guard duplicate >= 0 else { throw ControlNamespaceError.unavailable }
        var current = stat()
        guard fstat(duplicate, &current) == 0, Self.validLeaf(current), Self.same(current, directoryIdentity) else {
            close(duplicate); throw ControlNamespaceError.unavailable
        }
        do { try requireWitness() }
        catch { close(duplicate); throw ControlNamespaceError.unavailable }
        return duplicate
    }
    deinit { close(directoryFD); close(parentFD) }
    private static func validParent(_ value: stat, system: Bool) -> Bool {
        guard (value.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR) else { return false }
        return system ? value.st_uid == 0 && (value.st_mode & 0o7777) == 0o1777 :
            value.st_uid == geteuid() && (value.st_mode & 0o7777) == 0o700
    }
    private static func validLeaf(_ value: stat) -> Bool {
        (value.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR) && value.st_uid == geteuid() && (value.st_mode & 0o7777) == 0o700
    }
    private static func same(_ first: stat, _ second: stat) -> Bool { first.st_dev == second.st_dev && first.st_ino == second.st_ino }
}
