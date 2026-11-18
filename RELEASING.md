# Releasing X-wing

1. Run the **release** workflow from `main` with `publish` enabled and choose the version bump.
2. The workflow runs the backend matrix, frontend tests, typecheck, lint, bundle freshness check, and Playwright suite. It then bumps the version in `pyproject.toml`, `xwing/__init__.py`, `uv.lock`, `scripts/package.json`, and `scripts/package-lock.json`, builds and smoke-tests the wheel, publishes to PyPI through trusted publishing, and creates the `v<version>` tag and GitHub Release.
3. To preview, run with `publish` off. The distributions are kept as the `xwing-dist` artifact. Nothing is tagged, committed, or published.

## PyPI trusted publishing

The `pypi-publish` job uses OIDC. Configure the publisher on PyPI with:

- Owner: `anudeepd`
- Repository: `xwing`
- Workflow name: `release.yml`
- Environment: `pypi`

Create the `pypi` environment in the GitHub repository settings if it does not exist. No PyPI API token is stored in GitHub Actions.
