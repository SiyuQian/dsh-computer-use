import Darwin
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--help"] {
    print("Usage: CUStop stop\nRequests sticky revocation for this OS user. The acknowledgement is not a drain confirmation.\nLocal development binary; no controller is started or installed.")
    exit(0)
}
guard arguments == ["stop"] else {
    FileHandle.standardError.write(Data("CONTROL_STOP_USAGE: Use CUStop stop.\n".utf8)); exit(2)
}
do {
    let namespace = try ControlNamespace.existingProduction()
    guard try requestDiscoveredControlStop(namespace: namespace) else { throw ControlNamespaceError.unavailable }
    print("{\"status\":\"revoked\",\"drained\":false,\"dispatchable\":false}")
} catch {
    FileHandle.standardError.write(Data("CONTROL_STOP_UNAVAILABLE: Revocation was not confirmed. Do not assume work has drained.\n".utf8)); exit(2)
}
