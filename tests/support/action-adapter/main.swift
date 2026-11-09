import AppKit
import ApplicationServices
import Foundation

// Test-only API-boundary stubs. No real UI is queried and no real input is dispatched.
struct FixtureReadFailure: Error { let code: String }
func exactFixtureIdentity(pid: Int32, start: String) -> Bool { identityChecks += 1; return !(mode == "identity_lost_before_dispatch" && identityChecks > 2) }
nonisolated(unsafe) var mode = ""
nonisolated(unsafe) var identityChecks = 0
nonisolated(unsafe) var dispatches = 0
nonisolated(unsafe) var valueReads = 0
nonisolated(unsafe) var written = ""
nonisolated(unsafe) let windowNode = AXUIElementCreateApplication(2_147_483_645)
nonisolated(unsafe) let selectedNode = AXUIElementCreateApplication(2_147_483_644)
func same(_ first: AXUIElement, _ second: AXUIElement) -> Bool { CFEqual(first, second) }
nonisolated var pressMode: Bool { mode.hasPrefix("press") }

func AXIsProcessTrusted() -> Bool { mode != "untrusted" }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { ApplicationServices.AXUIElementCreateApplication(pid) }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) -> AXError { .success }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: UnsafeMutablePointer<pid_t>) -> AXError { pid.pointee = 41; return .success }
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ name: CFString, _ result: UnsafeMutablePointer<DarwinBoolean>) -> AXError { result.pointee = true; return .success }
func AXUIElementCopyActionNames(_ element: AXUIElement, _ output: UnsafeMutablePointer<CFArray?>) -> AXError {
    output.pointee = (pressMode ? [kAXPressAction] : []) as CFArray; return .success
}
func AXUIElementGetAttributeValueCount(_ element: AXUIElement, _ name: CFString, _ result: UnsafeMutablePointer<Int>) -> AXError {
    if name as String == kAXWindowsAttribute { result.pointee = 1; return .success }
    if same(element, windowNode) { result.pointee = 1; return .success }
    return .attributeUnsupported
}
func AXUIElementCopyAttributeValues(_ element: AXUIElement, _ name: CFString, _ index: CFIndex, _ maximum: CFIndex, _ output: UnsafeMutablePointer<CFArray?>) -> AXError {
    output.pointee = (name as String == kAXWindowsAttribute ? [windowNode] : same(element, windowNode) ? [selectedNode] : []) as CFArray
    return .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ name: CFString, _ output: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
    switch name as String {
    case kAXValueAttribute:
        valueReads += 1
        if mode == "set_readback_error" { return .cannotComplete }
        output.pointee = (mode == "set_readback_mismatch" ? "other" : written) as CFString
    case kAXRoleAttribute: output.pointee = (same(element, windowNode) ? "AXWindow" : pressMode ? "AXButton" : "AXTextField") as CFString
    case kAXSubroleAttribute:
        // Real macOS NSTextField/NSButton report attributeUnsupported for AXSubrole (observed 2026-11-09).
        if mode.hasSuffix("_unsupported_subrole") { return .attributeUnsupported }
        if mode.hasSuffix("_subrole_error") { return .cannotComplete }
        output.pointee = "" as CFString
    case kAXIdentifierAttribute:
        // Real AppKit unlabeled controls (window buttons, static text) report noValue (observed 2026-11-09).
        if mode.hasSuffix("_novalue_identifier") && !same(element, windowNode) && !same(element, selectedNode) { return .noValue }
        output.pointee = (same(element, windowNode) ? "fixture.window.primary.7.window_fixture" : pressMode ? "fixture.submit" : "fixture.text") as CFString
    case kAXHelpAttribute: output.pointee = (mode == "replaced" ? "fixture.element.element_other" : "fixture.element.element_fixture") as CFString
    case kAXEnabledAttribute: output.pointee = kCFBooleanTrue
    case kAXWindowAttribute: output.pointee = windowNode
    default: return .attributeUnsupported
    }
    return .success
}
func AXUIElementPerformAction(_ element: AXUIElement, _ action: CFString) -> AXError {
    dispatches += 1
    guard same(element, selectedNode), action as String == kAXPressAction else { return .illegalArgument }
    return mode == "press_timeout" ? .cannotComplete : .success
}
func AXUIElementSetAttributeValue(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) -> AXError {
    dispatches += 1
    guard same(element, selectedNode), name as String == kAXValueAttribute, let text = value as? String else { return .illegalArgument }
    if mode == "set_error" { return .cannotComplete }
    written = text
    return .success
}

guard CommandLine.arguments.count == 2 else { exit(2) }
mode = CommandLine.arguments[1]
let operation = pressMode ? "press" : "set_value"
var output: [String: Any]
do {
    output = try actFixture(pid: 41, start: "process_fixture", windowKey: "primary", windowId: 7, windowInstance: "window_fixture",
                            identifier: pressMode ? "fixture.submit" : "fixture.text", instance: "element_fixture", operation: operation,
                            value: pressMode ? nil : "PUBLIC_FIXTURE_VALUE")
} catch let error as FixtureReadFailure { output = ["status": "error", "code": error.code] }
catch { output = ["status": "unexpected"] }
output["dispatches"] = dispatches
output["valueReads"] = valueReads
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data + Data([10]))
