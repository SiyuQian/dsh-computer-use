import AppKit
import ApplicationServices
import Foundation

/// Single owned-fixture semantic action: AXPress or AXValue set on one exact, freshly revalidated element.
/// No keyboard, pointer, activation, retry, script, or selector path exists. The written value is never echoed.
func actFixture(pid: Int32, start: String, windowKey: String, windowId: Int, windowInstance: String,
                identifier: String, instance: String, operation: String, value: String?) throws -> [String: Any] {
    guard (operation == "press" && value == nil) || (operation == "set_value" && value != nil) else {
        throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE")
    }
    let located = try locateExactFixtureElement(pid: pid, start: start, windowKey: windowKey, windowId: windowId,
                                                windowInstance: windowInstance, identifier: identifier, instance: instance, operation: operation)
    let witness = "fixture.window.\(windowKey).\(windowId).\(windowInstance)"
    // Last check before the single dispatch. Anything after this point is reported as dispatched.
    guard AXIsProcessTrusted() else { throw FixtureReadFailure(code: "READ_DENIED") }
    guard fixtureWindowStillExact(pid: pid, start: start, window: located.window, witness: witness),
          fixtureElementStillExact(located.element, identifier: identifier, instance: instance, operation: operation) else {
        throw FixtureReadFailure(code: "TARGET_CHANGED")
    }
    if operation == "press" {
        let result = AXUIElementPerformAction(located.element, kAXPressAction as CFString)
        return ["status": "dispatched", "execution": result == .success ? "completed" : "unknown", "readback": "not_applicable"]
    }
    let result = AXUIElementSetAttributeValue(located.element, kAXValueAttribute as CFString, value! as CFString)
    guard result == .success else { return ["status": "dispatched", "execution": "unknown", "readback": "unavailable"] }
    // Readback on the same public fixture field only; never returned to the caller as text.
    guard let current = fixtureStringValue(located.element) else {
        return ["status": "dispatched", "execution": "completed", "readback": "unavailable"]
    }
    return ["status": "dispatched", "execution": "completed", "readback": current == value ? "match" : "mismatch"]
}
