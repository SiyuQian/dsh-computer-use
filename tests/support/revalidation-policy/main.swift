import Foundation

let fault = CommandLine.arguments.count == 2 ? CommandLine.arguments[1] : "invalid"
var node = FixtureElementMetadata(identifier: "fixture.text", instance: "element_fixture", role: "AXTextField", subrole: "", enabled: true, secure: false, actions: ["set_value"])
var complete = true
var nodes: [FixtureElementMetadata] = []
var operation = "set_value"
if fault == "replaced" { node = FixtureElementMetadata(identifier: node.identifier, instance: "element_replaced", role: node.role, subrole: node.subrole, enabled: true, secure: false, actions: node.actions) }
if fault == "missing_instance" { node = FixtureElementMetadata(identifier: node.identifier, instance: nil, role: node.role, subrole: node.subrole, enabled: true, secure: false, actions: node.actions) }
if fault == "disabled" { node = FixtureElementMetadata(identifier: node.identifier, instance: node.instance, role: node.role, subrole: node.subrole, enabled: false, secure: false, actions: node.actions) }
if fault == "secure" { node = FixtureElementMetadata(identifier: node.identifier, instance: node.instance, role: node.role, subrole: node.subrole, enabled: true, secure: true, actions: node.actions) }
if fault == "missing_subrole" { node = FixtureElementMetadata(identifier: node.identifier, instance: node.instance, role: node.role, subrole: nil, enabled: true, secure: false, actions: node.actions) }
if fault == "role_changed" { node = FixtureElementMetadata(identifier: node.identifier, instance: node.instance, role: "AXButton", subrole: "", enabled: true, secure: false, actions: node.actions) }
if fault == "wrong_identifier" { node = FixtureElementMetadata(identifier: "fixture.unknown", instance: node.instance, role: node.role, subrole: node.subrole, enabled: true, secure: false, actions: node.actions) }
if fault == "wrong_operation" { operation = "press" }
if fault == "incomplete" { complete = false }
nodes = [node]
if fault == "duplicate" { nodes.append(node) }
if fault == "same_identifier_twice" { nodes.append(FixtureElementMetadata(identifier: node.identifier, instance: "element_other", role: node.role, subrole: node.subrole, enabled: true, secure: false, actions: node.actions)) }
if fault == "reordered" { nodes.insert(FixtureElementMetadata(identifier: "fixture.submit", instance: "element_button", role: "AXButton", subrole: "", enabled: true, secure: false, actions: ["press"]), at: 0) }
var decision = decideFixtureElement(nodes: nodes, complete: complete, identifier: "fixture.text", instance: "element_fixture", operation: operation)
if ["child_error", "child_short_read", "detached_after_scan", "replaced_after_scan", "identifier_changed_after_scan", "cycle", "depth", "node_limit"].contains(fault) {
    let original = node
    var reads = 0
    let adapter = FixtureElementAdapter<Int>(metadata: { index in
        if index == 1 {
            reads += 1
            if reads > 1 && fault == "replaced_after_scan" { return FixtureElementMetadata(identifier: original.identifier, instance: "element_new", role: original.role, subrole: original.subrole, enabled: true, secure: false, actions: original.actions) }
            if reads > 1 && fault == "identifier_changed_after_scan" { return FixtureElementMetadata(identifier: "fixture.submit", instance: original.instance, role: original.role, subrole: original.subrole, enabled: true, secure: false, actions: original.actions) }
            return original
        }
        return FixtureElementMetadata(identifier: "group", instance: nil, role: "AXGroup", subrole: "", enabled: true, secure: false, actions: [])
    }, children: { index, _ in
        if index == 1 && fault == "child_error" { return nil }
        if index == 1 && fault == "child_short_read" { return FixtureChildren(values: [], complete: false) }
        if fault == "cycle" { return FixtureChildren(values: [1], complete: true) }
        if fault == "depth" { return FixtureChildren(values: [index + 1], complete: true) }
        if fault == "node_limit" && index == 0 { return FixtureChildren(values: Array(1...64), complete: true) }
        return FixtureChildren(values: index == 0 ? [1] : [], complete: true)
    }, same: { $0 == $1 }, belongsToWindow: { _ in fault != "detached_after_scan" })
    decision = scanFixtureElement(root: 0, identifier: "fixture.text", instance: "element_fixture", operation: operation, adapter: adapter).decision
}
let output = try! JSONSerialization.data(withJSONObject: ["status": decision.rawValue, "dispatchable": false], options: [.sortedKeys])
FileHandle.standardOutput.write(output + Data([10]))
