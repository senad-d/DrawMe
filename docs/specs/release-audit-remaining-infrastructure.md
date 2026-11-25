# Release audit: release authority, package gate and portable CI

Kind: infrastructure

## Purpose and scope

#46 release identity, #66 package completeness, #69 native Windows validation. Configure and test locally; no dispatch, tag, publish, bot PR changes or live CI/Sonar report.

## Today

| Environment | Resource | Defined in | Deployed by |
| --- | --- | --- | --- |
| Manual release | One privileged `publish` job using short ref and mutable tags | `.github/workflows/publish.yml` | Manual GitHub dispatch |
| CI | Ubuntu Node 24.x | `.github/workflows/ci.yml` | Push/PR |
| Local/CI | Allowlist over npm dry-run manifest | `scripts/check-package-contents.mjs`, `package.json:scripts.validate` | Same local and CI gate |

## Target

| Resource type | Name | Size | Environment | Added, changed or removed |
| --- | --- | --- | --- | --- |
| Jobs | `validate`, `publish` | Two sequential jobs | Release | Full default branch ref before environment allocation; successful read-only validation of same SHA. |
| Runner | `validate` matrix | Same Node on two OSes | CI | Add `windows-latest`, retain Ubuntu. |
| Pack check | `check:pack` | One dry-run manifest | Local/CI | Derive transitive local runtime imports from `pi.extensions`; compare to packed paths and retain existing resources/denials. |

## Environments

| Environment | Size | Data | Access | Domain |
| --- | --- | --- | --- | --- |
| Validation | Ephemeral runner | Dispatch SHA, locked dependencies | `contents: read`, no release env/OIDC | Static gates |
| Publication | Ephemeral restricted job | Same immutable SHA | `environment: npm`, `contents: write`, `id-token: write` only here | Existing npm provenance and release tag |
| Windows CI | One matrix leg | Portable fixtures | Read-only | Compatibility |

## Configuration and secrets

| Name | Kept in | Read by | Rotation |
| --- | --- | --- | --- |
| Default branch | GitHub event | Compare `github.ref` with `format('refs/heads/{0}', github.event.repository.default_branch)` | Dynamic; never hard-code `main` |
| `npm` environment | Existing repo settings | Publish only; restrict deployments to default branch, no tags | Update on default-branch rename |
| OIDC identity and repo token | Per-job permissions | Publish with provenance and tag only | Ephemeral; no npm token added |
| Action commits | Workflow `uses:` | Release jobs | Pin to reviewed full SHAs. Repo precedent `.github/workflows/sonar.yml`: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node `820762786026740c76f36085b0efc47a31fe5020`. Verify chosen commits support required Node/registry. |

## Rollout

1. Require exact ref at job boundary; `publish` needs successful read-only validation. Preserve dist-tag choices, metadata validation, version/tag uniqueness, concurrency, provenance and tag order. Check out the exact validated SHA in both jobs; publish with project lifecycle scripts disabled, without reinstalling dependencies or rerunning validation with privilege.
2. Statically check permission maps, environment placement, branch/tag/other-branch contexts, `needs`, pins and ordering. Record the required hosted environment rule; do not claim settings were inspected.
3. Determine runtime relative imports/re-exports (including literal dynamic imports; exclude type-only, built-ins and externals). Resolve extensionless local TS and fail clearly on missing runtime paths. Decide membership from packed files, not checkout existence.
4. Add native Windows matrix with existing install/gate commands and distinct job names. Inspect parsed workflow locally rather than dispatching.

## Rollback

| Step | How to return | What cannot be returned |
| --- | --- | --- |
| 1–2 | Disable manual publication while repairing a failed policy; don't restore broad authority | Nothing was published by this work |
| 3 | Restore gate while retaining omission regression | None; check is read-only |
| 4 | Restore matrix while fixing incompatibility | Past hosted runs unchanged |

## Cost

| Resource | Estimate per month | Price source |
| --- | --- | --- |
| GitHub-hosted Windows runner | One additional leg per applicable CI event. Unverified: monthly spend depends on event count, runtime and the repository's included minutes. | `.github/workflows/ci.yml` defines triggers; no billing entitlement or rate verified. |
| Existing manual release runners | Two jobs rather than one per release dispatch; no new service. Unverified: monthly spend depends on dispatch frequency and billed minutes. | `.github/workflows/publish.yml` defines manual dispatch; no billing entitlement or rate verified. |

## Risks

| Risk | Trigger | What it breaks | What limits it |
| --- | --- | --- | --- |
| Privilege returned indirectly | Reinstall/revalidate with release identity | Job separation defeated | Same validated revision, no project scripts in publish. |
| False pack pass | Use checkout instead of pack membership | Missing module shipped | Traverse checkout for graph; decide inclusion from pack and report missing path. |
| False Windows pass | POSIX fixtures skipped | Compatibility untested | Run portable fixtures through Node and verify fixture marker. |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Release guard | Restrict privileged job before environment allocation | Rely only on hosted policy | Reviewable and statically testable. |
| Pack gate | Runtime reachability | Extend manual list by four names | Next transitive omission otherwise goes unnoticed. |

## Open questions

| Question | Who can answer | What waits for it |
| --- | --- | --- |
| Unverified: what are the monthly billable minutes and applicable runner rates? | Repository billing administrator, only if a financial estimate is needed | Nothing in this local change; no usage forecast or live CI lookup is required. |
| Unverified: does the hosted `npm` environment currently restrict deployment to the default branch and no tags? | Repository environment administrator | Confirm/apply before actual release; no local task or live dispatch waits for this. |
