// Harness-only stand-in for ../lib/use-tenant-navigate. The real hook reads the
// tenant slug from router context (throws outside a <Router>). Return only the
// links your previewed component actually reads.
export function useNavLinks() {
  return { sources: "#sources" };
}
