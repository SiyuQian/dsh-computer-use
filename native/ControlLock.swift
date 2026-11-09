import Darwin
import Foundation

enum ControlLockError: Error { case unavailable, busy, lost }

/// Kernel exclusion primitive, not a native input capability. The caller must select one trusted per-user namespace.
/// This slice is used only by test-owned processes until the production broker and stop route are integrated.
final class ControlLock {
    private let directoryPath: String
    private let directoryFD: Int32
    private var lockFD: Int32
    private let directoryIdentity: stat
    private let lockIdentity: stat

    init(directory: String) throws {
        guard directory.hasPrefix("/"), !directory.contains("\0") else { throw ControlLockError.unavailable }
        guard let resolved = realpath(directory, nil) else { throw ControlLockError.unavailable }
        let canonical = String(cString: resolved)
        free(resolved)
        guard canonical == directory else { throw ControlLockError.unavailable }
        let dir = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dir >= 0 else { throw ControlLockError.unavailable }
        var directoryStat = stat()
        guard fstat(dir, &directoryStat) == 0, Self.validDirectory(directoryStat) else {
            close(dir); throw ControlLockError.unavailable
        }
        let file = openat(dir, "control.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600))
        guard file >= 0 else { close(dir); throw ControlLockError.unavailable }
        var fileStat = stat()
        guard fstat(file, &fileStat) == 0, Self.validFile(fileStat) else {
            close(file); close(dir); throw ControlLockError.unavailable
        }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
            let locked = errno == EWOULDBLOCK || errno == EAGAIN
            close(file); close(dir)
            throw locked ? ControlLockError.busy : ControlLockError.unavailable
        }
        directoryPath = directory
        directoryFD = dir
        lockFD = file
        directoryIdentity = directoryStat
        lockIdentity = fileStat
        do { try requireOwnership() }
        catch { throw ControlLockError.unavailable }
    }

    /// The only namespace an associated listener may use. Revalidate ownership before using the path.
    var namespaceDirectory: String { directoryPath }

    /// Recheck the namespace entry and descriptor witnesses. Same-user unlink/replace is not prevented by flock.
    func requireOwnership() throws {
        guard lockFD >= 0 else { throw ControlLockError.lost }
        var directoryStat = stat()
        var entryStat = stat()
        var descriptorStat = stat()
        guard lstat(directoryPath, &directoryStat) == 0, Self.validDirectory(directoryStat),
              Self.sameObject(directoryStat, directoryIdentity),
              fstatat(directoryFD, "control.lock", &entryStat, AT_SYMLINK_NOFOLLOW) == 0,
              Self.validFile(entryStat), Self.sameObject(entryStat, lockIdentity),
              fstat(lockFD, &descriptorStat) == 0, Self.validFile(descriptorStat),
              Self.sameObject(descriptorStat, lockIdentity) else { throw ControlLockError.lost }
    }

    /// Release only this descriptor. Never unlink or replace the stable lock inode.
    func release() {
        guard lockFD >= 0 else { return }
        close(lockFD)
        lockFD = -1
    }

    deinit { release(); close(directoryFD) }

    private static func validDirectory(_ value: stat) -> Bool {
        (value.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR) && value.st_uid == geteuid() &&
            (value.st_mode & 0o7777) == 0o700
    }
    private static func validFile(_ value: stat) -> Bool {
        (value.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) && value.st_uid == geteuid() &&
            (value.st_mode & 0o7777) == 0o600 && value.st_nlink == 1
    }
    private static func sameObject(_ first: stat, _ second: stat) -> Bool {
        first.st_dev == second.st_dev && first.st_ino == second.st_ino
    }
}
