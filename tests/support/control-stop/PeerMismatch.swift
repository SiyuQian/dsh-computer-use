import Darwin

// Test-only syscall interposition. The production peer check must fail before sending the private stop frame.
func getpeereid(_ descriptor: Int32, _ uid: UnsafeMutablePointer<uid_t>, _ gid: UnsafeMutablePointer<gid_t>) -> Int32 {
    uid.pointee = geteuid() == 0 ? 1 : 0
    gid.pointee = getegid()
    return 0
}
