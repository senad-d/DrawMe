# DrawMe tasks — batch 1

This task spec was generated from active SonarQube issues.

- Sonar project: `senad-d_DrawMe`
- Organization: `senad-d`
- Active issues read: 41

### 1. Eliminate non-linear regex backtracking in the format checker

- [ ] Resolve Sonar issue `AZ_H4Bf85bJuYeaozuv1`: Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking.

#### Why
Regular-expression backtracking can make worst-case evaluation time grow polynomially and significantly degrade performance on large or untrusted input.

#### How
Restructure the pattern to remove ambiguity, anchor it where appropriate, replace broad wildcards with separator-excluding character classes, or use bounded quantifiers.

#### Where
- `scripts/format-check.mjs:63`
- Rule: `javascript:S8786`
- Type/severity: `CODE_SMELL; MAJOR; RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 2. Iterate over DOM values with `for...of`

- [ ] Resolve Sonar issue `AZ_H4Bfh5bJuYeaozuvv`: Expected a `for-of` loop instead of a `for` loop with this simple iteration.

#### Why
A counter-based loop is unnecessarily verbose when only iterable values are needed, making the code less readable.

#### How
Replace the simple indexed loop with a `for...of` loop over the iterable values and remove the counter variable.

#### Where
- `src/dom.ts:23`
- Rule: `typescript:S4138`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 3. Replace the DOM null guard with optional chaining

- [ ] Resolve Sonar issue `AZ_H4Bfh5bJuYeaozuvw`: Prefer using an optional chain expression instead, as it's more concise and easier to read.

#### Why
Manual null and undefined checks before property access are verbose and can be error-prone; optional chaining expresses the same safe access more clearly.

#### How
Replace the logical guard with the equivalent `?.` optional-chain expression.

#### Where
- `src/dom.ts:25`
- Rule: `typescript:S6582`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 4. Use `for...of` for the second DOM iteration

- [ ] Resolve Sonar issue `AZ_H4Bfh5bJuYeaozuvx`: Expected a `for-of` loop instead of a `for` loop with this simple iteration.

#### Why
A counter-based loop is unnecessarily verbose when only iterable values are needed, making the code less readable.

#### How
Replace the simple indexed loop with a `for...of` loop over the iterable values and remove the counter variable.

#### Where
- `src/dom.ts:50`
- Rule: `typescript:S4138`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 5. Simplify the second DOM null guard with optional chaining

- [ ] Resolve Sonar issue `AZ_H4Bfh5bJuYeaozuvy`: Prefer using an optional chain expression instead, as it's more concise and easier to read.

#### Why
Manual null and undefined checks before property access are verbose and can be error-prone; optional chaining expresses the same safe access more clearly.

#### How
Replace the logical guard with the equivalent `?.` optional-chain expression.

#### Where
- `src/dom.ts:52`
- Rule: `typescript:S6582`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 6. Express the first backslash-heavy string with `String.raw`

- [ ] Resolve Sonar issue `AZ_H4Bet5bJuYeaozuva`: `String.raw` should be used to avoid escaping `\`.

#### Why
Escaped backslashes are difficult to read and maintain, increasing the chance of accidental escaping errors.

#### How
Replace the string literal with a `String.raw` template literal so its backslashes can be represented directly.

#### Where
- `src/drawio.ts:60`
- Rule: `typescript:S7780`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 7. Express the second backslash-heavy string with `String.raw`

- [ ] Resolve Sonar issue `AZ_H4Bet5bJuYeaozuvb`: `String.raw` should be used to avoid escaping `\`.

#### Why
Escaped backslashes are difficult to read and maintain, increasing the chance of accidental escaping errors.

#### How
Replace the string literal with a `String.raw` template literal so its backslashes can be represented directly.

#### Where
- `src/drawio.ts:61`
- Rule: `typescript:S7780`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 8. Use `RegExp.exec()` for draw.io pattern matching

- [ ] Resolve Sonar issue `AZ_H4Bet5bJuYeaozuvc`: Use the "RegExp.exec()" method instead.

#### Why
For a non-global regular expression, `String.match()` is semantically equivalent to `RegExp.exec()` while the latter can be slightly faster and states the matching operation directly.

#### How
Rewrite `string.match(regex)` as `regex.exec(string)` without changing the pattern or match handling.

#### Where
- `src/drawio.ts:79`
- Rule: `typescript:S6594`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 9. Use namespaced integer parsing in draw.io handling

- [ ] Resolve Sonar issue `AZ_H4Bet5bJuYeaozuvd`: Prefer `Number.parseInt` over `parseInt`.

#### Why
Using the `Number` namespace keeps number utilities explicit, organized, and consistent with modern ECMAScript practices.

#### How
Replace the global `parseInt` call with `Number.parseInt`, preserving its arguments and radix.

#### Where
- `src/drawio.ts:80`
- Rule: `typescript:S7773`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:MEDIUM, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 10. Simplify draw.io access with optional chaining

- [ ] Resolve Sonar issue `AZ_H4Bet5bJuYeaozuve`: Prefer using an optional chain expression instead, as it's more concise and easier to read.

#### Why
Manual null and undefined checks before access are verbose and can be error-prone; optional chaining provides concise, safe access.

#### How
Replace the logical guard with the equivalent `?.` optional-chain expression.

#### Where
- `src/drawio.ts:289`
- Rule: `typescript:S6582`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 11. Namespace the first integer parse in explanation handling

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvh`: Prefer `Number.parseInt` over `parseInt`.

#### Why
Using the `Number` namespace keeps number utilities explicit, organized, and consistent with modern ECMAScript practices.

#### How
Replace the global `parseInt` call with `Number.parseInt`, preserving its arguments and radix.

#### Where
- `src/explain.ts:33`
- Rule: `typescript:S7773`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:MEDIUM, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 12. Namespace the second integer parse in explanation handling

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvi`: Prefer `Number.parseInt` over `parseInt`.

#### Why
Using the `Number` namespace keeps number utilities explicit, organized, and consistent with modern ECMAScript practices.

#### How
Replace the global `parseInt` call with `Number.parseInt`, preserving its arguments and radix.

#### Where
- `src/explain.ts:34`
- Rule: `typescript:S7773`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:MEDIUM, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 13. Use `replaceAll()` for the first fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvj`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:35`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:LOW, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 14. Use `replaceAll()` for the second fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvk`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:36`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:LOW, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 15. Use `replaceAll()` for the third fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvl`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:37`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW, RELIABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 16. Use `replaceAll()` for the fourth fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvm`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:38`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:LOW, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 17. Use `replaceAll()` for the fifth fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvn`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:39`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW, RELIABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 18. Use `replaceAll()` for the sixth fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvo`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/explain.ts:40`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW, RELIABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 19. Eliminate non-linear regex backtracking in explanation parsing

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvp`: Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking.

#### Why
Regular-expression backtracking can make worst-case evaluation time grow polynomially and significantly degrade performance on large or untrusted input.

#### How
Restructure the pattern to remove ambiguity, anchor it where appropriate, replace broad wildcards with separator-excluding character classes, or use bounded quantifiers.

#### Where
- `src/explain.ts:47`
- Rule: `typescript:S8786`
- Type/severity: `CODE_SMELL; MAJOR; RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 20. Reduce explanation function cognitive complexity

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvq`: Refactor this function to reduce its Cognitive Complexity from 34 to the 15 allowed.

#### Why
High cognitive complexity makes control flow difficult to read, understand, test, and modify.

#### How
Break the function into single-responsibility helpers, extract complex conditions, use early returns to flatten nesting, and use null-safe operations where applicable. Ensure tests cover behavior before refactoring.

#### Where
- `src/explain.ts:82`
- Rule: `typescript:S3776`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.
