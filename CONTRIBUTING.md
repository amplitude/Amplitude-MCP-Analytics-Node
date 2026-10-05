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

## Cutting a release

Pushes to `main` do not open a release pull request. Run the **Release** workflow on `main` from the Actions tab. It opens or updates one pull request whose version and changelog come from Conventional Commits since the last tag. Squash-merge that pull request. The squash is tagged and published.

`main` only accepts a squash merge, and only when the branch is up to date with `main`. If commits land after the release pull request opens, merging stays blocked until the branch is current. Update branch does not satisfy that: Lint fails and tells you to re-run the Release workflow, which rebuilds the changelog from the latest `main`. If nothing since the last tag is releasable, the workflow opens no pull request and publishes nothing.
