# DrawMe tasks — batch 2

This task spec was generated from active SonarQube issues.

- Sonar project: `senad-d_DrawMe`
- Organization: `senad-d`
- Active issues read: 41

### 1. Combine consecutive array pushes at line 143

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvr`: Do not call `Array#push()` multiple times.

#### Why
Multiple consecutive calls add unnecessary invocation overhead and make related additions harder to scan.

#### How
Combine the consecutive `Array#push()` calls on the same array into one call with multiple arguments, preserving argument order.

#### Where
- `src/explain.ts:143`
- Rule: `typescript:S7778`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 2. Combine consecutive array pushes at line 144

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvs`: Do not call `Array#push()` multiple times.

#### Why
Multiple consecutive calls add unnecessary invocation overhead and make related additions harder to scan.

#### How
Combine the consecutive `Array#push()` calls on the same array into one call with multiple arguments, preserving argument order.

#### Where
- `src/explain.ts:144`
- Rule: `typescript:S7778`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 3. Eliminate non-linear regex backtracking in explanation output

- [ ] Resolve Sonar issue `AZ_H4BfB5bJuYeaozuvt`: Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking.

#### Why
Regular-expression backtracking can make worst-case evaluation time grow polynomially and significantly degrade performance on large or untrusted input.

#### How
Restructure the pattern to remove ambiguity, anchor it where appropriate, replace broad wildcards with separator-excluding character classes, or use bounded quantifiers.

#### Where
- `src/explain.ts:164`
- Rule: `typescript:S8786`
- Type/severity: `CODE_SMELL; MAJOR; RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 4. Extract the nested template literal at line 91

- [ ] Resolve Sonar issue `AZ_H4Be45bJuYeaozuvf`: Refactor this code to not use nested template literals.

#### Why
Nested template literals make interpolation harder to follow and increase the chance of confusion around backticks and escaping.

#### How
Compute the inner interpolated value in a separate, clearly named statement and interpolate that result into the outer template.

#### Where
- `src/index.ts:91`
- Rule: `typescript:S4624`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 5. Extract the nested template literal at line 132

- [ ] Resolve Sonar issue `AZ_H4Be45bJuYeaozuvg`: Refactor this code to not use nested template literals.

#### Why
Nested template literals make interpolation harder to follow and increase the chance of confusion around backticks and escaping.

#### How
Compute the inner interpolated value in a separate, clearly named statement and interpolate that result into the outer template.

#### Where
- `src/index.ts:132`
- Rule: `typescript:S4624`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 6. Eliminate non-linear backtracking in shape-search regex

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvN`: Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking.

#### Why
Regular-expression backtracking can make worst-case evaluation time grow polynomially and significantly degrade performance on large or untrusted input.

#### How
Restructure the pattern to remove ambiguity, anchor it where appropriate, replace broad wildcards with separator-excluding character classes, or use bounded quantifiers.

#### Where
- `src/shapesearch.ts:33`
- Rule: `typescript:S8786`
- Type/severity: `CODE_SMELL; MAJOR; RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 7. Make shape-search character handling Unicode-aware

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvO`: Prefer `String#codePointAt()` over `String#charCodeAt()`.

#### Why
`charCodeAt()` processes UTF-16 code units and can return incomplete values for Unicode characters represented by surrogate pairs.

#### How
Replace `charCodeAt()` with `codePointAt()` so complete Unicode code points are handled correctly.

#### Where
- `src/shapesearch.ts:39`
- Rule: `typescript:S7758`
- Type/severity: `CODE_SMELL; MINOR; RELIABILITY:LOW, MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 8. Use `.at()` for end-relative shape-search access

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvP`: Prefer `.at(…)` over `[….length - index]`.

#### Why
Manual end-relative index arithmetic is verbose, harder to read, and more susceptible to off-by-one errors.

#### How
Replace the `value[value.length - n]` access with the equivalent `value.at(-n)` call.

#### Where
- `src/shapesearch.ts:42`
- Rule: `typescript:S7755`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 9. Extract the `set` assignment from its sub-expression

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvQ`: Extract the assignment of "set" from this expression.

#### Why
Assignments inside larger expressions introduce hidden side effects, reduce readability, and can lead to confusion or errors.

#### How
Move the assignment to `set` into a separate statement before the surrounding expression, then use the assigned value in that expression.

#### Where
- `src/shapesearch.ts:56`
- Rule: `typescript:S1121`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 10. Reduce shape-search function cognitive complexity

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvR`: Refactor this function to reduce its Cognitive Complexity from 33 to the 15 allowed.

#### Why
High cognitive complexity makes control flow difficult to read, understand, test, and modify.

#### How
Break the function into single-responsibility helpers, extract complex conditions, use early returns to flatten nesting, and use null-safe operations where applicable. Ensure tests cover behavior before refactoring.

#### Where
- `src/shapesearch.ts:99`
- Rule: `typescript:S3776`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 11. Extract the nested shape-search ternary

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvS`: Extract this nested ternary operation into an independent statement.

#### Why
Nested ternaries are difficult to read and obscure the order in which conditions are evaluated.

#### How
Move the nested conditional into an independent statement or helper, using straightforward conditional control flow where clearer.

#### Where
- `src/shapesearch.ts:105`
- Rule: `typescript:S3358`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 12. Simplify shape-search access with optional chaining

- [ ] Resolve Sonar issue `AZ_H4BcQ5bJuYeaozuvT`: Prefer using an optional chain expression instead, as it's more concise and easier to read.

#### Why
Manual null and undefined checks before access are verbose and can be error-prone; optional chaining provides concise, safe access.

#### How
Replace the logical guard with the equivalent `?.` optional-chain expression.

#### Where
- `src/shapesearch.ts:132`
- Rule: `typescript:S6582`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 13. Use `Number.NaN` in validation

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvU`: Prefer `Number.NaN` over `NaN`.

#### Why
The `Number` namespace makes numeric values explicit, keeps the global namespace cleaner, and aligns with modern ECMAScript conventions.

#### How
Replace the global `NaN` value with `Number.NaN` while preserving the surrounding behavior.

#### Where
- `src/validate.ts:29`
- Rule: `typescript:S7773`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW, RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 14. Eliminate non-linear backtracking in validation regex

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvV`: Simplify this regular expression to reduce its runtime, as it has super-linear performance due to backtracking.

#### Why
Regular-expression backtracking can make worst-case evaluation time grow polynomially and significantly degrade performance on large or untrusted input.

#### How
Restructure the pattern to remove ambiguity, anchor it where appropriate, replace broad wildcards with separator-excluding character classes, or use bounded quantifiers.

#### Where
- `src/validate.ts:32`
- Rule: `typescript:S8786`
- Type/severity: `CODE_SMELL; MAJOR; RELIABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 15. Replace the redundant string wrapper with `String`

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvW`: function 'g' is equivalent to `String`. Use `String` directly.

#### Why
A wrapper that only delegates to a built-in conversion adds call overhead and code without changing behavior.

#### How
Replace function `g` with a direct reference to the built-in `String` conversion function.

#### Where
- `src/validate.ts:43`
- Rule: `typescript:S7770`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 16. Extract the nested validation ternary

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvX`: Extract this nested ternary operation into an independent statement.

#### Why
Nested ternaries are difficult to read and obscure the order in which conditions are evaluated.

#### How
Move the nested conditional into an independent statement or helper, using straightforward conditional control flow where clearer.

#### Where
- `src/validate.ts:150`
- Rule: `typescript:S3358`
- Type/severity: `CODE_SMELL; MAJOR; MAINTAINABILITY:MEDIUM`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 17. Reduce validation function complexity at line 191

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvY`: Refactor this function to reduce its Cognitive Complexity from 26 to the 15 allowed.

#### Why
High cognitive complexity makes control flow difficult to read, understand, test, and modify.

#### How
Break the function into single-responsibility helpers, extract complex conditions, use early returns to flatten nesting, and use null-safe operations where applicable. Ensure tests cover behavior before refactoring.

#### Where
- `src/validate.ts:191`
- Rule: `typescript:S3776`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 18. Reduce validation function complexity at line 222

- [ ] Resolve Sonar issue `AZ_H4Bej5bJuYeaozuvZ`: Refactor this function to reduce its Cognitive Complexity from 59 to the 15 allowed.

#### Why
High cognitive complexity makes control flow difficult to read, understand, test, and modify.

#### How
Break the function into single-responsibility helpers, extract complex conditions, use early returns to flatten nesting, and use null-safe operations where applicable. Ensure tests cover behavior before refactoring.

#### Where
- `src/validate.ts:222`
- Rule: `typescript:S3776`
- Type/severity: `CODE_SMELL; CRITICAL; MAINTAINABILITY:HIGH`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 19. Use `replaceAll()` for workflow fixed-text replacement

- [ ] Resolve Sonar issue `AZ_H4BfK5bJuYeaozuvu`: Prefer `String#replaceAll()` over `String#replace()`.

#### Why
A global regex for fixed text is less clear and easier to escape incorrectly than the dedicated `replaceAll()` API.

#### How
Replace `replace()` and its global fixed-text regex with `replaceAll()` and the equivalent string literal, preserving the replacement value.

#### Where
- `src/workflow.ts:8`
- Rule: `typescript:S7781`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW, RELIABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.

### 20. Use the dedicated length matcher in the PNG test

- [ ] Resolve Sonar issue `AZ_H4Bfy5bJuYeaozuv0`: Prefer "expect(fixed!).toHaveLength(body.length + 12)" over this generic assertion for better reporting; it works on any object with a numeric length property.

#### Why
A dedicated length assertion states intent more clearly and produces a more focused test failure than a generic numeric assertion.

#### How
Replace the generic assertion with `expect(fixed!).toHaveLength(body.length + 12)`.

#### Where
- `tests/png.test.ts:23`
- Rule: `typescript:S5906`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.
