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

Pushes to `main` do not open a release pull request. Run the **Release** workflow on `main` from the Actions tab. It opens or updates one pull request whose version and changelog come from Conventional Commits since the last tag. Merging that pull request tags the release commit from when the pull request was opened, and publishes that commit to npm.

A commit that lands on `main` after the pull request is open is not part of that tag. Re-run the workflow to update the same pull request so the new commit is in the changelog. Do not use "Update branch" on the release pull request. If nothing since the last tag is releasable, the workflow opens no pull request and publishes nothing.
