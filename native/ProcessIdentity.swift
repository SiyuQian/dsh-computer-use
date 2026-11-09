import Darwin
import Foundation

struct NativeProcessIdentity {
    let pid: Int32
    let start: String
    let executable: URL
}

func processIdentity(_ pid: Int32) -> NativeProcessIdentity? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
    guard count == size, info.pbi_pid == UInt32(pid), info.pbi_uid == getuid() else { return nil }
    var path = [CChar](repeating: 0, count: 4096)
    let pathCount = proc_pidpath(pid, &path, UInt32(path.count))
    guard pathCount > 0 else { return nil }
    let pathBytes = path.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
    let executable = URL(fileURLWithPath: String(decoding: pathBytes, as: UTF8.self)).resolvingSymlinksInPath()
    return NativeProcessIdentity(pid: pid, start: "process_\(info.pbi_start_tvsec)_\(info.pbi_start_tvusec)", executable: executable)
}
