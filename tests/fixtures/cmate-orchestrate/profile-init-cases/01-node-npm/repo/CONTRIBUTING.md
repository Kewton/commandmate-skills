# Contributing to widget

## Branch naming

Work branches are cut from `develop` and named after the issue they close:

```
git checkout -b feature/issue-<number>-<slug>
```

## Worktrees

Parallel work happens in a sibling worktree, never in the primary checkout:

```
git worktree add ../widget-issue-<number>-<slug> feature/issue-<number>-<slug>
```
