# Contributing to Zugzug

Thanks for your interest in contributing! This project uses the
[Developer Certificate of Origin (DCO)](https://developercertificate.org/)
to manage contributions.

> **New here?** Start with a
> [`good first issue`](https://github.com/Fredehagelund92/zugzug/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
> — each is small, self-contained, and spells out where to look and how to
> verify your change.

## DCO sign-off

Every commit must include a `Signed-off-by:` line that certifies you
wrote the code or have the right to contribute it under the project's
license:

    Signed-off-by: Your Name <your.email@example.com>

Add it automatically with:

    git commit -s -m "your message"

The full DCO 1.1 text is available at <https://developercertificate.org/>.

## Filing issues

Use GitHub Issues. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Bun version, Postgres version)

For security issues, please follow the disclosure flow in [SECURITY.md](./SECURITY.md) instead.

## Filing pull requests

1. Open an issue first if the change is substantial — saves rework
2. Fork the repo and create a topic branch
3. Make your changes; add tests
4. Install pre-commit hooks once with `make hooks` (runs Prettier + ESLint on staged files)
5. Sign your commits (`git commit -s`)
6. Run `bun run typecheck && bun run lint && bun run format:check && bun run test` in both `server/` and `app/` workspaces
7. See [docs/testing.md](docs/testing.md) for how the test layers are organized and how to add a test.
8. Open the PR

## Development setup

See the [README](./README.md) for getting started.

## Code of conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
