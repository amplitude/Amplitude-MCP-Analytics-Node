# Contributing

## Pull request titles

Squash-merge is on, so the pull request title is the commit on `main`. That commit is the only input that decides the next version and the changelog entry.

Use a [Conventional Commit](https://www.conventionalcommits.org/) title:

```
<type>(<optional scope>)!: <description>
```

| Type | Version bump |
| --- | --- |
| `feat` | minor |
| `fix`, `perf` | patch |
| A breaking change (`type!:`, or a `BREAKING CHANGE` footer) | minor while the package is 0.x, major from 1.0.0 |
| `docs`, `chore`, `test`, `refactor`, `build`, `ci`, `revert` | none |

The release pull request itself is titled `chore(main): release X.Y.Z`.

Dependency bumps from Dependabot use `build(deps):` or `build(deps-dev):`. The title check accepts a capital type, which is what older Dependabot titles used (`Build(deps-dev):`). release-please only treats a lowercase type as a version bump, so those dependency merges do not publish a release.

## Cutting a release

Merging to `main` is the only step. The release-please workflow opens one pull request, or updates the one already open, titled `chore(main): release X.Y.Z`. It bumps `package.json`, prepends `CHANGELOG.md`, and updates `.release-please-manifest.json` from Conventional Commits since the last tag. Later merges to `main` keep updating that same pull request, so it describes the next release. Squash-merging it tags the release and publishes the package to npm.

If nothing since the last tag is releasable, no release pull request is opened and nothing is published.
