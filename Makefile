.PHONY: test cover hooks

# Full local check, matches CI.
test:
	bash scripts/test-all.sh

# Coverage for both workspaces (server needs the test DB up).
cover:
	cd app && bun run test:coverage
	cd server && (bun run test:db:up || echo "test DB already available; continuing") && bun run test:coverage

# Install git pre-commit hooks.
hooks:
	bunx lefthook install
