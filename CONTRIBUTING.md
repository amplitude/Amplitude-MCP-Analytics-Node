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

Pushes to `main` do not open a release pull request. Run the **Release** workflow on `main` from the Actions tab. It opens or updates one pull request whose version and changelog come from Conventional Commits since the last tag. Merging that pull request tags the commit and publishes the package to npm.

Commits that land after the pull request is open are not included until someone runs the workflow again. That run updates the same pull request. If nothing since the last tag is releasable, the workflow opens no pull request and publishes nothing.
