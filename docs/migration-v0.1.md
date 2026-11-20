# Migration Guide: SDK v0.0 → v0.1

This guide helps you upgrade from SDK v0.0 to v0.1. It covers breaking changes, deprecated APIs and their replacements, step-by-step migration examples, and troubleshooting tips.

> **Note:** This document describes the changes between v0.0 and v0.1. Deprecation warnings are not yet emitted by the code; this guide is the source of truth for what has changed and what is planned for removal in future releases.

---

## Table of Contents

- [Overview](#overview)
- [Breaking Changes](#breaking-changes)
- [Deprecated APIs and Alternatives](#deprecated-apis-and-alternatives)
- [Step-by-Step Migration](#step-by-step-migration)
- [Troubleshooting](#troubleshooting)

---

## Overview

SDK v0.1 introduces a number of API refinements, renames, and structural changes intended to improve consistency and ergonomics. Most changes are mechanical and can be applied with a small number of find-and-replace operations, but a few require behavioral adjustments.

Before upgrading, we recommend:

1. Reading the [Breaking Changes](#breaking-changes) section in full.
2. Reviewing the [Deprecated APIs](#deprecated-apis-and-alternatives) section to plan for future removals.
3. Following the [Step-by-Step Migration](#step-by-step-migration) examples.
4. Running your test suite and consulting [Troubleshooting](#troubleshooting) if anything fails.

---

## Breaking Changes

The following changes are **breaking** and require code updates when upgrading from v0.0 to v0.1.

### 1. Package entry point renamed

The primary entry point has been renamed for clarity.

- **v0.0:** `import { Client } from 'sdk'`
- **v0.1:** `import { Client } from 'sdk'` remains valid, but the internal module path `sdk/lib/client` is no longer exported. Import from the package root instead.

**Action:** Replace any deep imports (e.g. `sdk/lib/client`, `sdk/dist/...`) with imports from the package root.

### 2. `Client` constructor options object

The constructor now accepts a single options object instead of positional arguments.

- **v0.0:** `new Client(apiKey, options)`
- **v0.1:** `new Client({ apiKey, ...options })`

**Action:** Wrap constructor arguments in an object and rename `apiKey` to the `apiKey` property.

### 3. `createRequest` renamed to `request`

The method used to issue requests has been renamed.

- **v0.0:** `client.createRequest(...)`
- **v0.1:** `client.request(...)`

**Action:** Rename all `createRequest` calls to `request`.

### 4. Callback-based methods replaced with Promises

All callback-style APIs have been replaced with Promise-based APIs.

- **v0.0:** `client.request(params, (err, result) => { ... })`
- **v0.1:** `await client.request(params)` (or `.then(...)`)

**Action:** Convert callback usage to `async`/`await` or `.then()` chains.

### 5. Error shape changed

Errors are now instances of `SdkError` with a stable `code` and `message` field. The legacy `error.error` string field has been removed.

- **v0.0:** `err.error` (string), `err.status`
- **v0.1:** `err.code` (string), `err.message` (string), `err.status` (number)

**Action:** Update error handling to read `err.code` and `err.message` instead of `err.error`.

### 6. Response envelope flattened

Responses no longer wrap payloads in a `data` envelope.

- **v0.0:** `const { data } = await client.request(...)`
- **v0.1:** `const result = await client.request(...)`

**Action:** Remove destructuring of `data` from responses.

### 7. Default timeout changed

The default request timeout has been reduced from 60 seconds to 30 seconds.

**Action:** If your workload requires longer requests, pass an explicit `timeout` option.

### 8. Node.js version requirement

v0.1 requires **Node.js 18 or later** (CI runs on Node 22). Node.js 16 and below are no longer supported.

**Action:** Upgrade your runtime to Node.js 18+.

### 9. Removed legacy helpers

The following helpers have been removed:

- `sdk.legacyRequest`
- `sdk.parseLegacyResponse`
- `sdk.createLegacyClient`

**Action:** Use `client.request` and the standard response types instead.

---

## Deprecated APIs and Alternatives

The following APIs still work in v0.1 but are **deprecated** and will be removed in a future release. Migrate to the alternatives as soon as possible.

| Deprecated API | Status | Replacement |
| --- | --- | --- |
| `client.createRequest(...)` | Deprecated | `client.request(...)` |
| `new Client(apiKey, options)` | Deprecated | `new Client({ apiKey, ...options })` |
| Callback-style methods | Deprecated | Promise-based methods (`await` / `.then`) |
| `err.error` field | Deprecated | `err.code` and `err.message` |
| `sdk.legacyRequest` | Removed in v0.1 | `client.request` |
| `sdk.parseLegacyResponse` | Removed in v0.1 | Standard response types |
| `sdk.createLegacyClient` | Removed in v0.1 | `new Client({ ... })` |

> **Note:** Deprecation warnings are not yet emitted at runtime. Treat this table as the authoritative list of APIs scheduled for removal.

---

## Step-by-Step Migration

The examples below show the **before** (v0.0) and **after** (v0.1) code for each change.

### Step 1: Update imports

**Before (v0.0):**

```ts
import { Client } from 'sdk/lib/client';
```

**After (v0.1):**

```ts
import { Client } from 'sdk';
```

### Step 2: Update the `Client` constructor

**Before (v0.0):**

```ts
const client = new Client('my-api-key', { timeout: 5000 });
```

**After (v0.1):**

```ts
const client = new Client({ apiKey: 'my-api-key', timeout: 5000 });
```

### Step 3: Rename `createRequest` to `request`

**Before (v0.0):**

```ts
const response = await client.createRequest({ path: '/users' });
```

**After (v0.1):**

```ts
const response = await client.request({ path: '/users' });
```

### Step 4: Convert callbacks to Promises

**Before (v0.0):**

```ts
client.createRequest({ path: '/users' }, (err, result) => {
  if (err) {
    console.error(err.error);
    return;
  }
  console.log(result.data);
});
```

**After (v0.1):**

```ts
try {
  const result = await client.request({ path: '/users' });
  console.log(result);
} catch (err) {
  console.error(err.code, err.message);
}
```

### Step 5: Update error handling

**Before (v0.0):**

```ts
try {
  await client.createRequest({ path: '/users' });
} catch (err) {
  if (err.error === 'NOT_FOUND') {
    // handle not found
  }
}
```

**After (v0.1):**

```ts
try {
  await client.request({ path: '/users' });
} catch (err) {
  if (err.code === 'NOT_FOUND') {
    // handle not found
  }
}
```

### Step 6: Remove the response `data` envelope

**Before (v0.0):**

```ts
const { data } = await client.createRequest({ path: '/users' });
console.log(data);
```

**After (v0.1):**

```ts
const result = await client.request({ path: '/users' });
console.log(result);
```

### Step 7: Set an explicit timeout if needed

**Before (v0.0):**

```ts
// Default timeout was 60s
const client = new Client('my-api-key');
```

**After (v0.1):**

```ts
// Default timeout is now 30s; set explicitly if you need longer
const client = new Client({ apiKey: 'my-api-key', timeout: 60_000 });
```

### Step 8: Replace removed legacy helpers

**Before (v0.0):**

```ts
const client = sdk.createLegacyClient('my-api-key');
const raw = await sdk.legacyRequest(client, { path: '/users' });
const parsed = sdk.parseLegacyResponse(raw);
```

**After (v0.1):**

```ts
const client = new Client({ apiKey: 'my-api-key' });
const parsed = await client.request({ path: '/users' });
```

---

## Troubleshooting

### `TypeError: client.createRequest is not a function`

You are calling a method that has been renamed. Replace `createRequest` with `request`.

### `TypeError: Cannot read properties of undefined (reading 'data')`

The response envelope has been flattened. Remove destructuring of `data` and use the response object directly.

### `err.error is undefined`

The `error` field has been removed from errors. Use `err.code` and `err.message` instead.

### Requests time out unexpectedly

The default timeout was reduced from 60s to 30s. Pass an explicit `timeout` option to `new Client({ ... })` if your requests need longer.

### `Cannot find module 'sdk/lib/client'`

Deep imports are no longer supported. Import from the package root (`'sdk'`).

### `SyntaxError: Unexpected token 'await'` or similar

Callback-based methods have been replaced with Promises. Ensure your function is `async` when using `await`, or use `.then()`.

### Node.js version errors

v0.1 requires Node.js 18 or later. Upgrade your runtime (CI uses Node 22).

### Still stuck?

- Re-read the [Breaking Changes](#breaking-changes) section to confirm all changes have been applied.
- Search your codebase for the deprecated identifiers listed above (`createRequest`, `legacyRequest`, `parseLegacyResponse`, `createLegacyClient`, `err.error`, `.data`).
- If you believe you have found a bug in the migration path, please open an issue with a minimal reproduction.

---

## Related

- See the project `README.md` for installation and usage.
- For questions about this migration, please open an issue in the repository.