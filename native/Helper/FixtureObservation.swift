import AppKit
import ApplicationServices
import Foundation

struct FixtureReadFailure: Error {
    let code: String
}

func exactFixtureIdentity(pid: Int32, start: String) -> Bool {
    guard let current = processIdentity(pid), current.start == start,
          let helper = processIdentity(getpid()) else { return false }
    let expected = helper.executable.deletingLastPathComponent()
        .appendingPathComponent("CUFixture.app/Contents/MacOS/CUFixture").resolvingSymlinksInPath()
    guard current.executable == expected else { return false }
    let bundleURL = expected.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return Bundle(url: bundleURL)?.bundleIdentifier == "dev.siyuqian.computer-use.fixture"
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

private func elements(_ element: AXUIElement, _ name: String, limit: Int) -> (values: [AXUIElement], truncated: Bool)? {
    var count = 0
    guard AXUIElementGetAttributeValueCount(element, name as CFString, &count) == .success else { return nil }
    if count == 0 { return ([], false) }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, name as CFString, 0, min(count, limit), &values) == .success,
          let typed = values as? [AXUIElement] else { return nil }
    return (typed, count > limit)
}

private func windowFrame(_ window: AXUIElement) -> [String: Double]? {
    guard let pointRaw = attribute(window, kAXPositionAttribute), CFGetTypeID(pointRaw) == AXValueGetTypeID(),
          let sizeRaw = attribute(window, kAXSizeAttribute), CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeDowncast(pointRaw, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeDowncast(sizeRaw, to: AXValue.self), .cgSize, &size),
          point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}

private struct FixtureWalker {
    var nodes: [[String: Any]] = []
    var reasons = Set<String>()
    var visited = Set<CFHashCode>()

    mutating func bounded(_ text: String, limit: Int) -> String {
        if text.utf16.count > limit { reasons.insert("text_limit") }
        // JSON length is bounded by UTF-16 units on the TS side. Prefix by Unicode scalar is also bounded below.
        var units = 0
        var result = ""
        for scalar in text.unicodeScalars {
            let count = scalar.utf16.count
            if units + count > limit { break }
            units += count
            result.unicodeScalars.append(scalar)
        }
        return result
    }

    mutating func walk(_ element: AXUIElement, depth: Int) {
        if depth > 12 { reasons.insert("depth_limit"); return }
        if nodes.count >= 64 { reasons.insert("node_limit"); return }
        let identity = CFHash(element)
        if !visited.insert(identity).inserted { reasons.insert("unavailable"); return }
        guard let role = stringAttribute(element, kAXRoleAttribute) else { reasons.insert("unavailable"); return }
        let subrole = fixtureSubrole(element)
        let identifier = stringAttribute(element, kAXIdentifierAttribute)
        let allowedRoles = [kAXButtonRole, kAXTextFieldRole, kAXStaticTextRole, kAXGroupRole, kAXWindowRole]
        let publicText = isPublicFixtureText(role: role, subrole: subrole, identifier: identifier)
        let secure = subrole == kAXSecureTextFieldSubrole || identifier == "fixture.secure" ||
            !allowedRoles.contains(role) || (role == kAXTextFieldRole && !publicText)
        let enabled = attribute(element, kAXEnabledAttribute) as? Bool ?? false
        let label = stringAttribute(element, kAXTitleAttribute) ?? stringAttribute(element, kAXDescriptionAttribute) ?? ""
        var node: [String: Any] = [
            "nativeId": "node_\(nodes.count)", "role": bounded(role, limit: 128),
            "subrole": bounded(subrole ?? "", limit: 128), "identifier": bounded(identifier ?? "", limit: 128),
            "label": bounded(label, limit: 256), "enabled": enabled, "secure": secure,
            "actions": [String](), "depth": depth,
        ]
        if !secure {
            if let identifier, fixtureActionIdentifiers.contains(identifier),
               let instance = fixtureElementInstance(stringAttribute(element, kAXHelpAttribute)) { node["elementInstance"] = instance }
            // Never request kAXValue for secure or unclassified roles.
            if let value = publicFixtureText(role: role, subrole: subrole, identifier: identifier, readValue: {
                stringAttribute(element, kAXValueAttribute)
            }) {
                node["value"] = bounded(value, limit: 1024)
            }
            var actions: [String] = []
            var nativeActions: CFArray?
            if enabled, role == kAXButtonRole,
               AXUIElementCopyActionNames(element, &nativeActions) == .success,
               (nativeActions as? [String])?.contains(kAXPressAction) == true { actions.append("press") }
            var settable: DarwinBoolean = false
            if enabled, role == kAXTextFieldRole,
               AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
               settable.boolValue { actions.append("set_value") }
            node["actions"] = actions
        }
        nodes.append(node)
        guard let children = elements(element, kAXChildrenAttribute, limit: 64) else {
            // Attribute-unsupported leaves are complete; other failures are reflected in the bounded public coverage.
            if role == kAXGroupRole || role == kAXWindowRole { reasons.insert("unavailable") }
            return
        }
        if children.truncated { reasons.insert("node_limit") }
        for child in children.values { walk(child, depth: depth + 1) }
    }
}

func observeFixture(pid: Int32, start: String, windowKey: String, windowId: Int, windowInstance: String) throws -> [String: Any] {
    guard exactFixtureIdentity(pid: pid, start: start) else { throw FixtureReadFailure(code: "TARGET_CHANGED") }
    guard AXIsProcessTrusted() else { throw FixtureReadFailure(code: "READ_DENIED") }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let windows = elements(app, kAXWindowsAttribute, limit: 8), !windows.truncated else {
        throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE")
    }
    let windowWitness = "fixture.window.\(windowKey).\(windowId).\(windowInstance)"
    let matches = windows.values.filter { stringAttribute($0, kAXIdentifierAttribute) == windowWitness }
    guard matches.count == 1, let window = matches.first else {
        throw FixtureReadFailure(code: matches.count > 1 ? "TARGET_AMBIGUOUS" : "TARGET_CHANGED")
    }
    var ownerPid: Int32 = 0
    guard AXUIElementGetPid(window, &ownerPid) == .success, ownerPid == pid,
          let frame = windowFrame(window) else { throw FixtureReadFailure(code: "CAPABILITY_UNAVAILABLE") }
    // The owned fixture publishes the real AppKit window number plus a per-window lifetime token.
    // Third-party apps without this witness are unsupported; no private window-number SPI or invented IDs.
    var walker = FixtureWalker()
    walker.walk(window, depth: 0)
    guard exactFixtureIdentity(pid: pid, start: start), stringAttribute(window, kAXIdentifierAttribute) == windowWitness else {
        throw FixtureReadFailure(code: "TARGET_CHANGED")
    }
    return [
        "pid": pid, "processStart": start, "bundleId": "dev.siyuqian.computer-use.fixture", "windowKey": windowKey,
        "windowId": windowId, "windowInstance": windowInstance,
        "frame": frame, "nodes": walker.nodes, "truncated": !walker.reasons.isEmpty, "reasons": walker.reasons.sorted(),
    ]
}
