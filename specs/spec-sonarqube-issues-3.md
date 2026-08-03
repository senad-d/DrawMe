# DrawMe tasks — batch 3

This task spec was generated from active SonarQube issues.

- Sonar project: `senad-d_DrawMe`
- Organization: `senad-d`
- Active issues read: 41

### 1. Use the dedicated length matcher in the shape-search test

- [ ] Resolve Sonar issue `AZ_H4Bfq5bJuYeaozuvz`: Prefer "expect(r).toHaveLength(5)" over this generic assertion for better reporting; it works on any object with a numeric length property.

#### Why
A dedicated length assertion states intent more clearly and produces a more focused test failure than a generic numeric assertion.

#### How
Replace the generic assertion with `expect(r).toHaveLength(5)`.

#### Where
- `tests/shapesearch.test.ts:7`
- Rule: `typescript:S5906`
- Type/severity: `CODE_SMELL; MINOR; MAINTAINABILITY:LOW`

#### Acceptance criteria
- The flagged Sonar issue is remediated at the listed location.
- Intended behavior is preserved.
- Tests passing.
