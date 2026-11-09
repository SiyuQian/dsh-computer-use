import Foundation

var rejectedReads = 0
let unknownCases: [(String?, String?, String?)] = [
    ("AXTextField", nil, "fixture.text"),
    ("AXTextField", "", nil),
    ("AXTextField", "AXSecureTextField", "fixture.text"),
    ("AXTextField", "", "fixture.secure"),
    ("AXTextField", "", "unknown"),
    (nil, "", "fixture.text"),
]
for (role, subrole, identifier) in unknownCases {
    let value = publicFixtureText(role: role, subrole: subrole, identifier: identifier) {
        rejectedReads += 1
        return "private-fixture-value"
    }
    guard value == nil else { exit(1) }
}
var allowedReads = 0
let publicValue = publicFixtureText(role: "AXTextField", subrole: "", identifier: "fixture.text") {
    allowedReads += 1
    return "public-fixture-text"
}
guard publicValue == "public-fixture-text", rejectedReads == 0, allowedReads == 1 else { exit(1) }
print("{\"ok\":true,\"rejectedValueReads\":0,\"allowedValueReads\":1}")
