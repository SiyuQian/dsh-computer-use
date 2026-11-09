import Foundation

enum FixtureElementDecision: String { case exact, changed = "TARGET_CHANGED", ambiguous = "TARGET_AMBIGUOUS", unavailable = "CAPABILITY_UNAVAILABLE" }
struct FixtureElementMetadata {
    let identifier: String
    let instance: String?
    let role: String?
    let subrole: String?
    let enabled: Bool
    let secure: Bool
    let actions: [String]
}
let fixtureActionIdentifiers = ["fixture.text", "fixture.submit", "fixture.replace", "fixture.reorder", "fixture.delayed", "fixture.save", "fixture.reset"]

/// Owned-fixture lifecycle metadata only. Neither node order nor labels can authenticate a replacement element.
func fixtureElementInstance(_ help: String?) -> String? {
    guard let help, help.hasPrefix("fixture.element.") else { return nil }
    let instance = String(help.dropFirst("fixture.element.".count))
    let bytes = Array(instance.utf8)
    guard instance.hasPrefix("element_"), bytes.count > 8, bytes.count <= 128,
          bytes.allSatisfy({ ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 || $0 == 45 }) else { return nil }
    return instance
}

/// Pure exact-selection decision. The caller must independently validate process/window identity and bounded complete AX coverage.
func decideFixtureElement(nodes: [FixtureElementMetadata], complete: Bool, identifier: String, instance: String, operation: String) -> FixtureElementDecision {
    guard complete else { return .unavailable }
    guard fixtureActionIdentifiers.contains(identifier), fixtureElementInstance("fixture.element." + instance) != nil else { return .changed }
    let matches = nodes.filter { $0.identifier == identifier }
    guard matches.count <= 1 else { return .ambiguous }
    guard let node = matches.first, node.instance == instance else { return .changed }
    guard !node.secure, node.enabled, node.actions.contains(operation), let subrole = node.subrole else { return .unavailable }
    if identifier == "fixture.text" {
        guard operation == "set_value", node.role == "AXTextField", ["", "AXStandardTextField"].contains(subrole) else { return .unavailable }
    } else {
        guard operation == "press", node.role == "AXButton", subrole.isEmpty else { return .unavailable }
    }
    return .exact
}
