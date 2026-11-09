import Darwin
import Foundation

func emit(_ status: String, childPid: Int32? = nil) {
    var fields: [String: Any] = ["status": status, "dispatchable": false]
    if let childPid { fields["childPid"] = childPid }
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

guard CommandLine.arguments.count == 3,
      ["--test-try-lock", "--test-hold-lock"].contains(CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("INVALID_ARGUMENTS\n".utf8)); exit(2)
}

do {
    let control = try ControlLock(directory: CommandLine.arguments[2])
    emit("locked")
    if CommandLine.arguments[1] == "--test-hold-lock" {
        // Inert test owner only. No GUI/input command exists. EOF represents a normal drain/release.
        while let line = readLine() {
            if line == "exec" {
                var pid: pid_t = 0
                let strings = [strdup("/bin/sleep"), strdup("30")]
                defer { for string in strings { free(string) } }
                var arguments = strings + [nil]
                var environment: [UnsafeMutablePointer<CChar>?] = [nil]
                let spawned = arguments.withUnsafeMutableBufferPointer { pointer in
                    environment.withUnsafeMutableBufferPointer { env in
                        posix_spawn(&pid, "/bin/sleep", nil, nil, pointer.baseAddress!, env.baseAddress!)
                    }
                }
                guard spawned == 0 else { exit(2) }
                emit("exec_started", childPid: pid)
            } else if line == "check" {
                do { try control.requireOwnership(); emit("owned") }
                catch { emit("lost") }
            } else { exit(2) }
        }
    }
    control.release()
} catch ControlLockError.busy {
    emit("busy"); exit(3)
} catch {
    FileHandle.standardError.write(Data("CONTROL_LOCK_UNAVAILABLE\n".utf8)); exit(2)
}
