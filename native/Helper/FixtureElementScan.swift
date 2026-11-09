import Foundation

struct FixtureChildren<Node> { let values: [Node]; let complete: Bool }
struct FixtureElementAdapter<Node> {
    let metadata: (Node) -> FixtureElementMetadata?
    let children: (Node, Int) -> FixtureChildren<Node>?
    let same: (Node, Node) -> Bool
    let belongsToWindow: (Node) -> Bool
}
struct FixtureElementScanResult<Node> { let decision: FixtureElementDecision; let element: Node? }

/// Bounded metadata-only traversal. Any unknown children response or invalid window membership closes the exact-selection path.
func scanFixtureElement<Node>(root: Node, identifier: String, instance: String, operation: String, adapter: FixtureElementAdapter<Node>) -> FixtureElementScanResult<Node> {
    var visited: [Node] = []
    var found: [(Node, FixtureElementMetadata)] = []
    var complete = true
    func walk(_ node: Node, depth: Int) {
        guard complete else { return }
        guard depth <= 12, visited.count < 64, !visited.contains(where: { adapter.same($0, node) }) else { complete = false; return }
        visited.append(node)
        guard let metadata = adapter.metadata(node) else { complete = false; return }
        if metadata.identifier == identifier { found.append((node, metadata)) }
        guard let children = adapter.children(node, 64), children.complete, children.values.count <= 64 else { complete = false; return }
        for child in children.values { walk(child, depth: depth + 1) }
    }
    walk(root, depth: 0)
    let decision = decideFixtureElement(nodes: found.map { $0.1 }, complete: complete, identifier: identifier, instance: instance, operation: operation)
    guard decision == .exact, let element = found.first?.0 else { return FixtureElementScanResult(decision: decision, element: nil) }
    guard adapter.belongsToWindow(element), let current = adapter.metadata(element), current.identifier == identifier, current.instance == instance else {
        return FixtureElementScanResult(decision: .changed, element: nil)
    }
    let final = decideFixtureElement(nodes: [current], complete: true, identifier: identifier, instance: instance, operation: operation)
    return FixtureElementScanResult(decision: final, element: final == .exact ? element : nil)
}
