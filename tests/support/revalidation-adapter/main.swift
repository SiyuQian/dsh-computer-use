import AppKit
import ApplicationServices
import Foundation

struct FixtureReadFailure: Error { let code: String }
func exactFixtureIdentity(pid: Int32, start: String) -> Bool { true }
nonisolated(unsafe) var mode = ""
nonisolated(unsafe) var childCounts = 0
nonisolated(unsafe) var windowCounts = 0
nonisolated(unsafe) var valueReads = 0
nonisolated(unsafe) let applicationNode = AXUIElementCreateApplication(2_147_483_646)
nonisolated(unsafe) let windowNode = AXUIElementCreateApplication(2_147_483_645)
nonisolated(unsafe) let selectedNode = AXUIElementCreateApplication(2_147_483_644)
nonisolated(unsafe) let unrelatedNode = AXUIElementCreateApplication(2_147_483_643)
nonisolated(unsafe) let otherWindow = AXUIElementCreateApplication(2_147_483_642)
func same(_ first: AXUIElement, _ second: AXUIElement) -> Bool { CFEqual(first, second) }

// Compile-time function interposition exercises the real adapter's error handling, without real UI data or TCC.
func AXIsProcessTrusted() -> Bool { true }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { ApplicationServices.AXUIElementCreateApplication(pid) }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) -> AXError { .success }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: UnsafeMutablePointer<pid_t>) -> AXError { pid.pointee = 41; return .success }
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ name: CFString, _ result: UnsafeMutablePointer<DarwinBoolean>) -> AXError { result.pointee = true; return .success }
func AXUIElementCopyActionNames(_ element: AXUIElement, _ output: UnsafeMutablePointer<CFArray?>) -> AXError { output.pointee = [] as CFArray; return .success }
func AXUIElementGetAttributeValueCount(_ element: AXUIElement, _ name: CFString, _ result: UnsafeMutablePointer<Int>) -> AXError {
    if name as String == kAXWindowsAttribute {
        windowCounts += 1
        result.pointee = mode == "window_identifier_error" ? 2 : mode == "window_count_grow" && windowCounts > 1 ? 2 : 1
        return .success
    }
    if same(element, windowNode) { result.pointee = 2; return .success }
    if same(element, selectedNode) {
        if mode == "children_error" { return .cannotComplete }
        if mode == "zero_children_grow" { childCounts += 1; result.pointee = childCounts == 1 ? 0 : 1; return .success }
    }
    return .attributeUnsupported
}
func AXUIElementCopyAttributeValues(_ element: AXUIElement, _ name: CFString, _ index: CFIndex, _ maximum: CFIndex, _ output: UnsafeMutablePointer<CFArray?>) -> AXError {
    if name as String == kAXWindowsAttribute { output.pointee = (mode == "window_identifier_error" ? [windowNode, otherWindow] : [windowNode]) as CFArray }
    else if same(element, windowNode) { output.pointee = mode == "short_children" ? [selectedNode] as CFArray : [selectedNode, unrelatedNode] as CFArray }
    else { output.pointee = [] as CFArray }
    return .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ name: CFString, _ output: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
    switch name as String {
    case kAXValueAttribute: valueReads += 1; return .failure
    case kAXRoleAttribute: output.pointee = (same(element, windowNode) ? "AXWindow" : "AXTextField") as CFString
    case kAXSubroleAttribute:
        // Real macOS NSTextField/NSButton report attributeUnsupported for AXSubrole (observed 2026-11-09).
        if mode.hasSuffix("_unsupported_subrole") { return .attributeUnsupported }
        if mode.hasSuffix("_subrole_error") { return .cannotComplete }
        output.pointee = "" as CFString
    case kAXIdentifierAttribute:
        // Real AppKit unlabeled controls (window buttons, static text) report noValue (observed 2026-11-09).
        if mode.hasSuffix("_novalue_identifier") && !same(element, windowNode) && !same(element, selectedNode) { return .noValue }
        if same(element, otherWindow), mode == "window_identifier_error" { return .cannotComplete }
        if same(element, unrelatedNode), mode == "identifier_error" { return .cannotComplete }
        if same(element, unrelatedNode), mode == "identifier_wrong_type" { output.pointee = true as CFBoolean; return .success }
        output.pointee = (same(element, windowNode) ? "fixture.window.primary.7.window_fixture" : same(element, selectedNode) ? "fixture.text" : "fixture.other") as CFString
    case kAXHelpAttribute: output.pointee = "fixture.element.element_fixture" as CFString
    case kAXEnabledAttribute: output.pointee = kCFBooleanTrue
    case kAXWindowAttribute:
        if mode == "detached" { return .invalidUIElement }
        output.pointee = mode == "window_detached_after_scan" ? otherWindow : windowNode
    default: return .attributeUnsupported
    }
    return .success
}

guard CommandLine.arguments.count == 2 else { exit(2) }
mode = CommandLine.arguments[1]
var status = "exact"
do {
    try revalidateFixture(pid: 41, start: "process_fixture", windowKey: "primary", windowId: 7, windowInstance: "window_fixture",
                          identifier: "fixture.text", instance: "element_fixture", operation: "set_value")
} catch let error as FixtureReadFailure { status = error.code }
catch { status = "unexpected" }
let output = try! JSONSerialization.data(withJSONObject: ["status": status, "valueReads": valueReads, "dispatchable": false], options: [.sortedKeys])
FileHandle.standardOutput.write(output + Data([10]))
