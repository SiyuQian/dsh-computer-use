import ApplicationServices
import Foundation

func isPublicFixtureText(role: String?, subrole: String?, identifier: String?) -> Bool {
    guard role == "AXTextField", identifier == "fixture.text", let subrole else { return false }
    return subrole.isEmpty || subrole == "AXStandardTextField"
}

func publicFixtureText(role: String?, subrole: String?, identifier: String?, readValue: () -> String?) -> String? {
    guard isPublicFixtureText(role: role, subrole: subrole, identifier: identifier) else { return nil }
    return readValue()
}


/// AXSubrole: real AppKit text fields and buttons return attributeUnsupported, meaning "no subrole" (""). Any other
/// failure stays unknown (nil) so policy fails closed.
func fixtureSubrole(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &value)
    if result == .attributeUnsupported || result == .noValue { return "" }
    guard result == .success else { return nil }
    return value as? String
}
