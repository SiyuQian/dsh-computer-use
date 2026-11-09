import Darwin
import Foundation

nonisolated(unsafe) var active = false
nonisolated(unsafe) var mode = ""
nonisolated(unsafe) var writes = 0
nonisolated(unsafe) var syncs = 0
nonisolated(unsafe) var closed: [Int32: Int] = [:]
nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var alternateDirectory = ""

func open(_ path: UnsafePointer<CChar>, _ flags: Int32) -> Int32 {
    if active && mode == "redirect_directory" && (flags & O_DIRECTORY) != 0 {
        return Darwin.open(alternateDirectory, flags)
    }
    return Darwin.open(path, flags)
}
func getuid() -> uid_t { mode == "uid_mismatch" ? Darwin.geteuid() + 1 : Darwin.getuid() }
func geteuid() -> uid_t { mode == "root_uid" ? 0 : Darwin.geteuid() }
func fstatat(_ directory: Int32, _ path: UnsafePointer<CChar>, _ info: UnsafeMutablePointer<stat>, _ flags: Int32) -> Int32 {
    if active && mode == "namespace_init" { failures += 1; errno = EIO; return -1 }
    return Darwin.fstatat(directory, path, info, flags)
}
@discardableResult func close(_ descriptor: Int32) -> Int32 {
    if active { closed[descriptor, default: 0] += 1 }
    return Darwin.close(descriptor)
}
func write(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Int {
    if active {
        writes += 1
        if mode == "write_fail" { errno = EIO; return -1 }
        if mode == "zero_write" { return 0 }
        if mode == "crash_created" { _exit(7) }
        if mode == "crash_partial" {
            if writes == 1 { return Darwin.write(fd, bytes, min(17, count)) }
            _exit(7)
        }
        if mode == "short_write" { return Darwin.write(fd, bytes, min(17, count)) }
    }
    return Darwin.write(fd, bytes, count)
}
func fsync(_ fd: Int32) -> Int32 {
    if active {
        syncs += 1
        if mode == "file_sync_fail" || (mode == "directory_sync_fail" && syncs == 2) { errno = EIO; return -1 }
    }
    return Darwin.fsync(fd)
}
func linkat(_ fromDirectory: Int32, _ from: UnsafePointer<CChar>, _ toDirectory: Int32, _ to: UnsafePointer<CChar>, _ flags: Int32) -> Int32 {
    if active && mode == "link_fail" { errno = EIO; return -1 }
    let result = Darwin.linkat(fromDirectory, from, toDirectory, to, flags)
    if active && mode == "crash_linked" && result == 0 { _exit(7) }
    return result
}

guard CommandLine.arguments.count == 3 else { exit(2) }
mode = CommandLine.arguments[1]
let parent = CommandLine.arguments[2]
var rejected = false
var complete = false
do {
    if ["namespace_init", "uid_mismatch", "root_uid"].contains(mode) {
        active = true
        do { _ = try ControlNamespace.createUnderOwnedParent(parent) }
        catch { rejected = true }
        active = false
    } else {
        if mode == "redirect_directory" {
            alternateDirectory = parent + "/alternate"
            guard mkdir(alternateDirectory, mode_t(0o700)) == 0 else { throw ControlNamespaceError.unavailable }
            let marker = open(alternateDirectory + "/stop.endpoint", O_CREAT | O_EXCL | O_WRONLY, mode_t(0o600))
            guard marker >= 0 else { throw ControlNamespaceError.unavailable }
            let data = Data("test-marker".utf8)
            _ = data.withUnsafeBytes { Darwin.write(marker, $0.baseAddress!, $0.count) }; Darwin.close(marker)
        }
        let namespace = try ControlNamespace.createUnderOwnedParent(parent)
        var otherNamespace: ControlNamespace?
        if mode == "different_namespace" {
            let otherParent = parent + "/other"
            guard mkdir(otherParent, mode_t(0o700)) == 0 else { throw ControlNamespaceError.unavailable }
            otherNamespace = try ControlNamespace.createUnderOwnedParent(otherParent)
        }
        let lock = try ControlLock(directory: otherNamespace?.directory ?? namespace.directory)
        if mode == "released_lock" { lock.release() }
        if ["different_namespace", "released_lock"].contains(mode) {
            do {
                _ = try StopDiscovery(namespace: namespace, control: lock, generation: "generation_fixture", capability: String(repeating: "a", count: 64))
                complete = true
            } catch { rejected = true }
            lock.release()
            throw ControlNamespaceError.unavailable
        }
        let generation = "generation_fixture"
        let capability = String(repeating: "a", count: 64)
        let channel = try StopListener(control: lock, directory: namespace.directory, generation: generation, capability: capability)
        active = true
        do {
            let discovery = try StopDiscovery(namespace: namespace, control: lock, generation: generation, capability: capability)
            complete = true
            active = false
            discovery.closeAfterDrain()
        } catch { rejected = true; active = false }
        channel.closeAfterDrain(); lock.release()
    }
} catch { rejected = true; active = false }
let data = try! JSONSerialization.data(withJSONObject: [
    "rejected": rejected, "complete": complete, "writes": writes, "syncs": syncs,
    "closeCalls": closed.values.reduce(0, +), "uniqueCloses": closed.count, "witnessFailures": failures, "dispatchable": false,
], options: [.sortedKeys])
FileHandle.standardOutput.write(data + Data([10]))
