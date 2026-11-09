import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

let frameLimit = 8192

func stop(_ code: String) -> Never {
    FileHandle.standardError.write(Data("\(code): Native request rejected.\n".utf8))
    exit(2)
}

func readFrame(_ descriptor: Int32, limit: Int) -> Data {
    var frame = Data()
    var byte: UInt8 = 0
    while true {
        let count = Darwin.read(descriptor, &byte, 1)
        if count == -1 && errno == EINTR { continue }
        guard count == 1 else { stop("INVALID_FRAME") }
        if byte == 10 { return frame }
        guard frame.count < limit else { stop("FRAME_TOO_LARGE") }
        frame.append(byte)
    }
}

func validId(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= 128 else { return false }
    func letterOrDigit(_ byte: UInt8) -> Bool {
        (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57)
    }
    return letterOrDigit(bytes[0]) && bytes.allSatisfy { letterOrDigit($0) || $0 == 95 || $0 == 45 }
}

// fd 7 is the public DSH subprocess control channel. This rejects accidental direct use,
// but does not authenticate against arbitrary malicious code running as the same OS user.
guard Array(CommandLine.arguments.dropFirst()) == ["--managed-stdio"] else { stop("INVALID_ARGUMENTS") }
var channelInfo = stat()
guard fstat(7, &channelInfo) == 0,
      (channelInfo.st_mode & S_IFMT) == S_IFSOCK || (channelInfo.st_mode & S_IFMT) == S_IFIFO else {
    stop("MANAGED_CHANNEL_REQUIRED")
}
let launchData = readFrame(7, limit: 128)
guard let launchId = String(data: launchData, encoding: .utf8), validId(launchId) else { stop("INVALID_LAUNCH") }
let raw = readFrame(STDIN_FILENO, limit: frameLimit)
var extra: UInt8 = 0
var remaining = Darwin.read(STDIN_FILENO, &extra, 1)
while remaining == -1 && errno == EINTR { remaining = Darwin.read(STDIN_FILENO, &extra, 1) }
guard remaining == 0 else { stop("EXTRA_FRAME") }
guard let object = try? JSONSerialization.jsonObject(with: raw),
      let request = object as? [String: Any],
      let version = request["protocolVersion"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
      let requestId = request["requestId"] as? String, validId(requestId),
      request["launchId"] as? String == launchId,
      let command = request["command"] as? String else { stop("INVALID_REQUEST") }

var response: [String: Any] = ["protocolVersion": 1, "requestId": requestId, "launchId": launchId]
switch command {
case "health":
    guard Set(request.keys) == Set(["protocolVersion", "requestId", "launchId", "command"]) else { stop("INVALID_REQUEST") }
    // Preflight never prompts or captures. This branch reads no UI content.
    response.merge([
        "status": "ok", "commands": ["health", "observe_fixture", "revalidate_fixture"], "helperPid": ProcessInfo.processInfo.processIdentifier,
        "capabilities": ["axObservation": false, "mutation": false, "keyboard": false, "pointer": false],
        "permissions": ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()],
    ]) { _, new in new }
case "observe_fixture":
    guard Set(request.keys) == Set(["protocolVersion", "requestId", "launchId", "command", "target"]),
          let target = request["target"] as? [String: Any],
          Set(target.keys) == Set(["pid", "processStart", "windowKey", "windowId", "windowInstance"]),
          let pid = target["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(),
          pid.doubleValue.rounded() == pid.doubleValue, pid.doubleValue > 0, pid.doubleValue <= Double(Int32.max),
          let start = target["processStart"] as? String, validId(start),
          let key = target["windowKey"] as? String, ["primary", "secondary"].contains(key),
          let windowId = target["windowId"] as? NSNumber, CFGetTypeID(windowId) != CFBooleanGetTypeID(),
          windowId.doubleValue.rounded() == windowId.doubleValue, windowId.doubleValue > 0, windowId.doubleValue <= Double(Int32.max),
          let instance = target["windowInstance"] as? String, validId(instance) else { stop("INVALID_REQUEST") }
    do {
        response["snapshot"] = try observeFixture(pid: pid.int32Value, start: start, windowKey: key,
                                                 windowId: windowId.intValue, windowInstance: instance)
        response["status"] = "ok"
    } catch let error as FixtureReadFailure {
        response["status"] = "error"
        response["code"] = error.code
    } catch {
        response["status"] = "error"
        response["code"] = "CAPABILITY_UNAVAILABLE"
    }
case "revalidate_fixture":
    guard let canonical = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]), canonical == raw else { stop("INVALID_REQUEST") }
    guard Set(request.keys) == Set(["protocolVersion", "requestId", "launchId", "command", "target", "element"]),
          let target = request["target"] as? [String: Any],
          Set(target.keys) == Set(["pid", "processStart", "windowKey", "windowId", "windowInstance"]),
          let pid = target["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(),
          pid.doubleValue.rounded() == pid.doubleValue, pid.doubleValue > 0, pid.doubleValue <= Double(Int32.max),
          let start = target["processStart"] as? String, validId(start),
          let key = target["windowKey"] as? String, ["primary", "secondary"].contains(key),
          let windowId = target["windowId"] as? NSNumber, CFGetTypeID(windowId) != CFBooleanGetTypeID(),
          windowId.doubleValue.rounded() == windowId.doubleValue, windowId.doubleValue > 0, windowId.doubleValue <= Double(Int32.max),
          let windowInstance = target["windowInstance"] as? String, validId(windowInstance),
          let element = request["element"] as? [String: Any], Set(element.keys) == Set(["identifier", "instance", "operation"]),
          let identifier = element["identifier"] as? String, fixtureActionIdentifiers.contains(identifier),
          let instance = element["instance"] as? String, fixtureElementInstance("fixture.element." + instance) != nil,
          let operation = element["operation"] as? String, ["press", "set_value"].contains(operation) else { stop("INVALID_REQUEST") }
    response["dispatchable"] = false
    do {
        try revalidateFixture(pid: pid.int32Value, start: start, windowKey: key, windowId: windowId.intValue,
                              windowInstance: windowInstance, identifier: identifier, instance: instance, operation: operation)
        response["status"] = "exact"; response["target"] = target; response["element"] = element
    } catch let error as FixtureReadFailure {
        response["status"] = "error"; response["code"] = error.code
    } catch { response["status"] = "error"; response["code"] = "CAPABILITY_UNAVAILABLE" }
default: stop("INVALID_REQUEST")
}
guard let output = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) else { stop("ENCODING_ERROR") }
FileHandle.standardOutput.write(output + Data("\n".utf8))
