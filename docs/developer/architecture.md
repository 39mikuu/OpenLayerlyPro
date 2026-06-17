# Developer Architecture

Start with:

- [../architecture/core-system.md](../architecture/core-system.md)
- [../architecture/config-center.md](../architecture/config-center.md)
- [../architecture/theme-system.md](../architecture/theme-system.md)
- [../architecture/i18n-ai-translation.md](../architecture/i18n-ai-translation.md)
- [../architecture/integration-plugin-system.md](../architecture/integration-plugin-system.md)
- [../architecture/deployment-network-edge.md](../architecture/deployment-network-edge.md)

## Core Rule

Route handlers parse requests and return responses. Business rules belong in `src/modules/*`.

## Release Rule

Do not mix unrelated product work into release-readiness PRs. Document uncertain findings in the release audit instead of making broad refactors.
