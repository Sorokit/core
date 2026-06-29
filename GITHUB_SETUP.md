# GitHub Repository Setup Guide

This document explains how to configure your GitHub repository to prevent CI failures and conflicts from reaching main.

## Branch Protection Rules (REQUIRED)

### Steps to Set Up

1. Go to your repository on GitHub
2. Click **Settings** (top right)
3. Click **Branches** (left sidebar)
4. Click **Add rule** under "Branch protection rules"
5. Fill in the following:

### Rule Configuration

**Branch name pattern:** `main`

Under "Protect matching branches":

- ✅ **Require a pull request before merging**
  - ✅ Require approvals: `1` (or more)
  - ✅ Require review from code owners: `false` (unless you have CODEOWNERS)
  - ✅ Dismiss stale pull request approvals when new commits are pushed

- ✅ **Require status checks to pass before merging**
  - ✅ Require branches to be up to date before merging
  - Add these required status checks (they will appear after the first CI run):
    - `test (18.x)`
    - `test (20.x)`
    - `validate-merge`

- ✅ **Require conversation resolution before merging**

- ✅ **Require code reviews**
  - Number of approvals: `1`

- ✅ **Require linear history** (recommended for clean git history)

- ❌ **Allow force pushes** (keep disabled)

- ❌ **Allow deletions** (keep disabled)

Click **Create** to save the rule.

### What This Does

- **Requires PR before merge** — No direct pushes to main, everything goes through review
- **Requires status checks** — CI must pass before merge is allowed
- **Requires update before merge** — PR branch must be up to date with main (GitHub automatically offers "Update branch" button)
- **Dismiss stale approvals** — If new commits are pushed after approval, the approval is reset (ensures latest code is reviewed)
- **Requires conversation resolution** — All comments/feedback must be addressed

## GitHub Actions CI

The `.github/workflows/ci.yml` file runs automatically on every PR and push to main.

### What It Does

- Runs on Node 18 and 20
- Runs type-check, linter, tests, and build
- Validates that the merge commit would pass all checks
- Takes ~3-5 minutes to complete

### Viewing Results

- On the PR page, scroll down to see "Checks" section
- Click "Details" next to any failed check to see the error
- Red ✗ = failed, Green ✓ = passed

## Enforcing Merge Strategy

### Set Merge Behavior

1. Go to **Settings** → **General**
2. Under "Pull Requests", set:
   - ✅ **Allow squash merging**
   - ❌ Uncheck "Allow merge commits" (optional, cleaner history)
   - ❌ Uncheck "Allow rebase merging" (optional, simpler for users)

This ensures all PRs are squashed into a single commit on main, keeping history clean.

## Preventing Common Issues

### Issue: "CI passes on PR but fails after merge"

**Cause:** Another PR merged between when your CI ran and when you clicked merge.

**Solution:** GitHub's branch protection rule requires "up to date before merge" — this will show you an "Update branch" button. Click it to rebase your PR on latest main, then CI re-runs.

### Issue: "Merge conflicts"

**Cause:** Your branch is based on an old main, and another PR changed the same files.

**Solution:**

1. Pull latest main locally
2. Merge/rebase main into your branch
3. Resolve conflicts manually
4. Verify tests pass: `npm run test`
5. Push the resolved branch
6. GitHub will re-run CI

### Issue: "Can't merge — status checks required"

**Cause:** CI is still running or has failed.

**Solution:** Wait for CI to finish, fix any errors, then merge.

## Continuous Monitoring

### Post-Merge Verification

Consider adding a post-merge workflow that:

- Runs the full test suite again (in case of race condition)
- Deploys to staging
- Notifies on Slack if main is broken

Example workflow trigger:

```yaml
on:
  push:
    branches: [main]
```

## Rollback Procedure

If a merge breaks main:

1. Identify the problematic commit (run tests locally)
2. Create a revert commit: `git revert <commit-hash>`
3. Push to a new branch, create PR
4. Once merged to main, the issue is rolled back
5. Create an issue to discuss the root cause
6. The original PR author investigates and fixes

---

After setting up branch protection, contributors will be forced to follow the right process, and bad merges won't reach main.
