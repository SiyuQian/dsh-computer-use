import Foundation

func isPublicFixtureText(role: String?, subrole: String?, identifier: String?) -> Bool {
    guard role == "AXTextField", identifier == "fixture.text", let subrole else { return false }
    return subrole.isEmpty || subrole == "AXStandardTextField"
}

func publicFixtureText(role: String?, subrole: String?, identifier: String?, readValue: () -> String?) -> String? {
    guard isPublicFixtureText(role: role, subrole: subrole, identifier: identifier) else { return nil }
    return readValue()
}
