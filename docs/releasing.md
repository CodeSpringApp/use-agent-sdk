# Releasing the SDK

Releases are public, immutable, and built by `.github/workflows/release.yml`
from a protected `v*` tag. The workflow runs the full SDK check before
publishing and uses npm's GitHub Actions OIDC integration; no npm token belongs
in repository or environment secrets.

The npm package owner configures the trusted publisher once:

```sh
npm trust github @codespring-app/use-agent \
  --repo CodeSpringApp/use-agent-sdk \
  --file release.yml \
  --env npm \
  --allow-publish \
  --yes
```

The npm CLI must be 11.5.1 or newer. The npm trusted-publisher settings must
match the repository, workflow filename, and `npm` GitHub environment exactly.

For each release:

1. Update `package.json` and the changelog in a reviewed commit.
2. Run `bun run check` and inspect `npm pack --dry-run`.
3. Create and push the matching tag, such as `v0.2.0`.
4. Verify the GitHub Actions release and anonymous installation from npm.

Trusted publishing automatically attaches provenance for this public package
and public repository. Tag protection and GitHub environment reviewers are the
human approval boundary.

References:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm package provenance](https://docs.npmjs.com/generating-provenance-statements/)
