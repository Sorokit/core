# Contributing to sorokit-core

Thanks for your interest in contributing to `sorokit-core`. This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

Be respectful and constructive. We're building a framework for the Stellar ecosystem, and we want everyone to feel welcome contributing.

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Git

### Development Setup

1. **Fork and clone the repository**

   ```bash
   git clone https://github.com/YOUR-USERNAME/sorokit-core.git
   cd sorokit-core
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Verify the setup**

   ```bash
   npm run typecheck
   npm run test
   npm run lint
   ```

## Development Workflow

### Before You Start

- Check [existing issues](https://github.com/Just-Bamford/sorokit-core/issues) to see if the work is already in progress
- For large changes, open a discussion or issue first to get feedback
- Ensure you're working against the latest `main` branch

### Making Changes

1. **Create a branch**

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix-name
   ```

   Use descriptive branch names:
   - `feature/add-contract-deployment` for new features
   - `fix/handle-network-errors` for bug fixes
   - `docs/update-readme` for documentation
   - `chore/upgrade-dependencies` for maintenance

2. **Write or update code**
   - Follow the existing code style (enforced by ESLint)
   - Add tests for new functionality
   - Update TypeScript types as needed
   - Keep functions pure and stateless where possible (aligns with sorokit-core's design)

3. **Run checks locally**

   ```bash
   npm run typecheck    # Check TypeScript types
   npm run lint         # Run ESLint
   npm run test         # Run tests with vitest
   ```

   All checks must pass before opening a PR.

4. **Commit your changes**

   ```bash
   git add src/...
   git commit -m "Description of changes"
   ```

   Keep commits focused and descriptive. Use imperative mood: "Add feature" not "Added feature".

5. **Push and open a pull request**

   ```bash
   git push origin feature/your-feature-name
   ```

   Then open a PR on GitHub with a clear title and description.

## Pull Request Guidelines

### Before Opening a PR

**CRITICAL: Keep your branch up to date with main**

Before pushing, always rebase/merge the latest main:

```bash
git fetch origin main
git rebase origin/main
# or if conflicts exist, resolve and commit
npm run typecheck && npm run lint && npm run test
git push origin your-branch
```

This prevents conflicts during merge and ensures CI passes on the merge commit.

### PR Title

Keep titles concise and under 70 characters:

- ✅ `Add Soroban contract reader`
- ✅ `Fix network error handling`
- ❌ `Fix a bug that occurs when you try to read a Soroban contract and the network times out`

### PR Description

Include:

- **What** — A clear summary of the changes
- **Why** — Motivation for the change (fixes issue #X, implements feature Y)
- **Testing** — What you tested and how
- **Blockers** — Any known issues or limitations

**Template:**

```markdown
## Summary

Brief description of changes

## Motivation

Fixes #123 / Implements feature X

## Testing

- [ ] Added unit tests
- [ ] Manual testing on testnet
- [ ] Verified types with `npm run typecheck`

## Checklist

- [ ] Code follows project style
- [ ] Tests pass locally
- [ ] No breaking changes (or documented breaking change)
```

### Review Process

**PR Merge Requirements:**

Your PR can only be merged if ALL of the following are true:

1. ✅ **All CI checks pass** — type-check, lint, test, build
2. ✅ **At least 1 reviewer approval** — code review complete
3. ✅ **No unresolved conversations** — feedback addressed
4. ✅ **Branch is up to date with main** — enforced by GitHub, use "Update branch" button if needed
5. ✅ **No merge conflicts** — resolved before merge attempt

**Process:**

- Address feedback promptly
- Respond to comments even if you disagree
- Use "Update branch" button to sync with main if needed
- CI will re-run after update to verify everything still passes
- If a PR becomes stale (inactive for 2+ weeks), it may be closed

## Testing

### Running Tests

```bash
# Run all tests once
npm run test

# Run in watch mode for development
npm run test:watch

# Run specific test file
npm run test -- account.test.ts
```

### Writing Tests

- Use `vitest` (already configured)
- Place tests alongside source in `src/tests/`
- Test both happy paths and error cases
- Use the `SorokitResult` type for assertion clarity

**Example:**

```ts
import { describe, it, expect } from "vitest";
import { createSorokitClient } from "../client";

describe("account", () => {
  it("returns error when account not found", async () => {
    const client = createSorokitClient({ network: "testnet" });
    if (client.status === "error") throw new Error("Client failed");

    const result = await client.data.account.get("INVALID");
    expect(result.status).toBe("error");
  });
});
```

## Code Style

The project uses ESLint. Run `npm run lint` to check and fix issues automatically where possible:

```bash
npm run lint -- --fix
```

### Style Guidelines

- **Modules** — Organize code into focused modules (e.g., `wallet/`, `account/`)
- **Exports** — Use barrel exports (`index.ts`) to control public API surface
- **Types** — Keep types alongside implementation, or in `src/types/` for shared types
- **Naming** — Use clear, descriptive names; avoid abbreviations except for well-known terms
- **Comments** — Document complex logic and non-obvious design decisions
- **Result Type** — Every async function returns `SorokitResult<T>`; no try/catch patterns

### Design Principles

When adding new features, keep these principles in mind:

1. **Stateless** — No persistent state in the client; side effects only for network calls
2. **No-throw** — Use `SorokitResult<T>` for error handling
3. **Framework-agnostic** — No dependency on React, Vue, or other frameworks
4. **Type-safe** — Leverage TypeScript for compile-time safety

## Type Checking

TypeScript types must be valid. Run:

```bash
npm run typecheck
```

No `any` without justification. If you must use `any`, add a comment explaining why.

## Documentation

- Update the **README** if you add or change public APIs
- Add inline comments for complex logic
- Include JSDoc comments for exported functions and types
- Update the **CHANGELOG** for user-facing changes (if applicable)

## Dependency Management

- **Avoid new dependencies** unless absolutely necessary
- **Peer dependencies** go in `peerDependencies` (e.g., Stellar Wallets Kit, vitest)
- **Dev dependencies** go in `devDependencies` (e.g., build tools, linters)
- **Runtime dependencies** go in `dependencies` (currently only `@stellar/stellar-sdk`)
- **Pin versions** in package.json for stability

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- `MAJOR` — Breaking changes
- `MINOR` — New backward-compatible features
- `PATCH` — Bug fixes

Bump the version in `package.json` for releases (maintainers handle this).

## Issues and Discussions

### Found a Bug?

1. Check if it's already reported in [issues](https://github.com/Just-Bamford/sorokit-core/issues)
2. If not, open a new issue with:
   - Clear title
   - Minimal reproduction code
   - Expected vs. actual behavior
   - Environment (Node version, OS, etc.)

### Feature Requests

1. Open a discussion or issue describing the feature
2. Explain the use case and why it's needed
3. Propose an API design (or ask for suggestions)
4. Wait for feedback before starting work

## Build and Release

- **Build:** `npm run build` — Outputs to `dist/` (ESM and CJS)
- **Clean:** `npm run clean` — Removes `dist/`
- **Dev:** `npm run dev` — Watch mode for development

Releases are handled by maintainers and published to npm.

## Asking for Help

- Open a [discussion](https://github.com/Just-Bamford/sorokit-core/discussions) if you have questions
- Tag maintainers in issues if you need clarification
- Check existing docs and code before asking (good learning opportunity!)

## Recognition

Contributors will be recognized in the project. Significant contributions may be mentioned in the README and CHANGELOG.

## License

By contributing, you agree that your contributions are licensed under the MIT license (same as the project).

---

Thank you for contributing to `sorokit-core`. Happy coding!
