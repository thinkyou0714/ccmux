# Contributing to ccmux

Thanks for your interest in contributing.

## Development setup

Requires Node 22+ and Zellij 0.40+.

```bash
git clone https://github.com/thinkyou0714/ccmux
cd ccmux
npm install
npm test
npm run lint
```

## Development workflow

1. Create a branch from `main`
2. Make changes — follow existing code style
3. Run tests and lint locally
4. Commit using Conventional Commits format:
   - `feat(scope): description` for new features
   - `fix(scope): description` for bug fixes
   - `chore(scope): description` for maintenance
   - `docs(scope): description` for docs only
5. Push and open a PR with a clear description

## Pull request guidelines

- One concern per PR — split large changes
- Include test plan in PR description
- Add or update tests for new behavior
- Update README if user-facing behavior changes

## Code style

- TypeScript strict mode
- ESLint must pass — `npm run lint`
- Prefer existing utilities over new abstractions
- No new dependencies without justification

## Reporting bugs

Use the **Bug report** issue template. Include:
- ccmux version (`ccmux --version`)
- OS, Zellij version, Node version, Claude Code version
- Steps to reproduce
- Expected vs actual behavior

## Suggesting features

Use the **Feature request** issue template, or start a Discussion in **Ideas** category to gauge interest first.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) — see also [thinkyou0714/.github](https://github.com/thinkyou0714/.github) for org-wide policies.
