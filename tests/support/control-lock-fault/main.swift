import Darwin
import Foundation

nonisolated(unsafe) var closed: [Int32: Int] = [:]
nonisolated(unsafe) var witnessFailures = 0

// Deterministic syscall-boundary fault after initialization transferred both real descriptors to the object.
func fstatat(_ directory: Int32, _ path: UnsafePointer<CChar>, _ output: UnsafeMutablePointer<stat>, _ flags: Int32) -> Int32 {
    witnessFailures += 1
    errno = ENOENT
    return -1
}
@discardableResult func close(_ descriptor: Int32) -> Int32 {
    closed[descriptor, default: 0] += 1
    return Darwin.close(descriptor)
}

guard CommandLine.arguments.count == 2 else { exit(2) }
var rejected = false
do { _ = try ControlLock(directory: CommandLine.arguments[1]) }
catch { rejected = true }
let uniqueCloses = closed.count
let totalCloses = closed.values.reduce(0, +)
let safe = rejected && witnessFailures == 1 && uniqueCloses == 2 && totalCloses == 2
let data = try! JSONSerialization.data(withJSONObject: [
    "ok": safe, "rejected": rejected, "witnessFailures": witnessFailures,
    "uniqueDescriptors": uniqueCloses, "closeCalls": totalCloses,
], options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
exit(safe ? 0 : 1)
