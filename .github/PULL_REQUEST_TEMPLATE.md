## Summary

- 

## Scope

- [ ] Schema or migration change
- [ ] Auth/session/security change
- [ ] Payment or review flow change
- [ ] File upload/download or storage change
- [ ] AI translation change
- [ ] Plugin or theme boundary change
- [ ] Public UI behavior change
- [ ] Documentation-only change

## Validation

- [ ] `pnpm test`
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm check:request-bodies`
- [ ] `pnpm check:auth-before-body`
- [ ] `pnpm check:task-boundaries`
- [ ] `pnpm exec tsc --noEmit`
- [ ] `pnpm build:migrator`
- [ ] `pnpm build:files-backfill`
- [ ] `pnpm build:admin-reset`
- [ ] `pnpm build:magic-link-rollback`
- [ ] `pnpm build:restore-tools`
- [ ] `pnpm build`

## Notes

Describe any migration, deployment, security, or compatibility concerns.
