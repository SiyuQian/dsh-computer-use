import AppKit
import ApplicationServices
import Foundation

private func revalidationAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
private func revalidationMetadata(_ element: AXUIElement) -> FixtureElementMetadata? {
    guard let role = revalidationAttribute(element, kAXRoleAttribute) as? String else { return nil }
    var rawIdentifier: CFTypeRef?
    let identifierResult = AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &rawIdentifier)
    let identifier: String
    if identifierResult == .attributeUnsupported { identifier = "" }
    else if identifierResult == .success, let text = rawIdentifier as? String { identifier = text }
    else { return nil }
    let subrole = revalidationAttribute(element, kAXSubroleAttribute) as? String
    let enabled = revalidationAttribute(element, kAXEnabledAttribute) as? Bool ?? false
    let secure = subrole == kAXSecureTextFieldSubrole || identifier == "fixture.secure" ||
        (role == kAXTextFieldRole && !isPublicFixtureText(role: role, subrole: subrole, identifier: identifier))
    var actions: [String] = []
    if !secure && enabled {
        var names: CFArray?
        if role == kAXButtonRole, AXUIElementCopyActionNames(element, &names) == .success,
           (names as? [String])?.contains(kAXPressAction) == true { actions.append("press") }
        var settable: DarwinBoolean = false
        if role == kAXTextFieldRole, AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
           settable.boolValue { actions.append("set_value") }
    }
    return FixtureElementMetadata(identifier: identifier, instance: fixtureElementInstance(revalidationAttribute(element, kAXHelpAttribute) as? String),
                                  role: role, subrole: subrole, enabled: enabled, secure: secure, actions: actions)
}

private func revalidationChildren(_ element: AXUIElement, limit: Int) -> FixtureChildren<AXUIElement>? {
    var count = 0
    let result = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
    if result == .attributeUnsupported {
        let role = revalidationAttribute(element, kAXRoleAttribute) as? String
        guard role == kAXButtonRole || role == kAXTextFieldRole || role == kAXStaticTextRole else { return nil }
        return FixtureChildren(values: [], complete: true)
    }
    guard result == .success, count >= 0, count <= limit else { return nil }
    if count == 0 {
        var after = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &after) == .success, after == 0 else { return nil }
        return FixtureChildren(values: [], complete: true)
    }
    var raw: CFArray?
    guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &raw) == .success,
          let values = raw as? [AXUIElement], values.count == count else { return nil }
    var after = 0
    guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &after) == .success, after == count else { return nil }
    return FixtureChildren(values: values, complete: true)
}

/// Read-only exact fixture probe. It never reads text values or mutates AX state, and its result is not an execution permit.
func revalidateFixture(pid: Int32, start: String, windowKey: String, windowId: Int, windowInstance: String,
                       identifier: String, instance: String, operation: String) throws {
    guard exactFixtureIdentity(pid: pid, start: start) else { throw FixtureReadFailure(code: "TARGET_CHANGED") }
    guard AXIsProcessTrusted() else { throw FixtureReadFailure(code: "READ_DENIED") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    var count = 0
    guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &count) == .success, count >= 0, count <= 8 else {
        throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE")
    }
    var raw: CFArray?
    guard AXUIElementCopyAttributeValues(app, kAXWindowsAttribute as CFString, 0, count, &raw) == .success,
          let windows = raw as? [AXUIElement], windows.count == count else { throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE") }
    var afterCount = 0
    guard AXUIElementGetAttributeValueCount(app, kAXWindowsAttribute as CFString, &afterCount) == .success, afterCount == count else {
        throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE")
    }
    let witness = "fixture.window.\(windowKey).\(windowId).\(windowInstance)"
    var matches: [AXUIElement] = []
    for candidate in windows {
        guard let identifier = revalidationAttribute(candidate, kAXIdentifierAttribute) as? String else {
            throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE")
        }
        if identifier == witness { matches.append(candidate) }
    }
    guard matches.count == 1, let window = matches.first else { throw FixtureReadFailure(code: matches.count > 1 ? "TARGET_AMBIGUOUS" : "TARGET_CHANGED") }
    var owner: Int32 = 0
    guard AXUIElementGetPid(window, &owner) == .success, owner == pid else { throw FixtureReadFailure(code: "TARGET_CHANGED") }
    let adapter = FixtureElementAdapter<AXUIElement>(metadata: revalidationMetadata, children: revalidationChildren,
        same: { CFEqual($0, $1) }, belongsToWindow: { node in
            var nodePid: Int32 = 0
            guard AXUIElementGetPid(node, &nodePid) == .success, nodePid == pid,
                  let actualWindow = revalidationAttribute(node, kAXWindowAttribute), CFGetTypeID(actualWindow) == AXUIElementGetTypeID() else { return false }
            return CFEqual(actualWindow, window)
        })
    let selected = scanFixtureElement(root: window, identifier: identifier, instance: instance, operation: operation, adapter: adapter)
    guard selected.decision == .exact else { throw FixtureReadFailure(code: selected.decision.rawValue) }
    guard exactFixtureIdentity(pid: pid, start: start), revalidationAttribute(window, kAXIdentifierAttribute) as? String == witness else {
        throw FixtureReadFailure(code: "TARGET_CHANGED")
    }
}
