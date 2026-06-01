# Contributing to Rentars

Thank you for your interest in contributing to Rentars! This document outlines our development workflow, coding standards, and pull request process.

## Code of Conduct

We are committed to providing a welcoming and inclusive experience for everyone. By participating in this project, you agree to:

- Be respectful and inclusive in all interactions
- Use welcoming and inclusive language
- Be accepting of differing viewpoints and experiences
- Gracefully accept constructive criticism
- Focus on what is best for the community

We do not tolerate harassment or discrimination based on:
- Race, ethnicity, or national origin
- Gender identity or expression
- Sexual orientation
- Age
- Disability
- Religion

## Getting Started

### Prerequisites

| Tool | Version | Installation |
|------|---------|-------------|
| Bun | >= 1.0 | [bun.sh](https://bun.sh) |
| Node.js | >= 20 | [nodejs.org](https://nodejs.org) |
| Rust | Latest | [rustup.rs](https://rustup.rs) |
| Docker | Latest | [docker.com](https://docker.com) |

### Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/rentars.git
cd rentars

# 2. Install dependencies
yarn install

# 3. Configure environment
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local

# 4. Start development services
docker compose -f apps/backend/docker-compose.yml up -d
cd apps/backend && bun run dev

# 5. Verify setup
# Frontend: http://localhost:3001
# Backend: http://localhost:3000
```

---

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

| Prefix | Usage | Example |
|--------|-------|---------|
| `feat/` | New features | `feat/add-property-search` |
| `fix/` | Bug fixes | `fix/booking-validation-error` |
| `docs/` | Documentation | `docs/api-reference` |
| `chore/` | Maintenance | `chore/update-deps` |
| `refactor/` | Code refactoring | `refactor/auth-flow` |
| `test/` | Tests | `test/booking-integration` |

### Commit Conventions

We follow [Conventional Commits](https://conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

#### Types

| Type | Description |
|------|-------------|
| `feat` | New feature or functionality |
| `fix` | Bug fix |
| `docs` | Documentation changes only |
| `style` | Code style changes (formatting, no logic) |
| `refactor` | Code refactoring (no feature/fix) |
| `test` | Adding or updating tests |
| `chore` | Maintenance, deps, build changes |
| `perf` | Performance improvements |
| `ci` | CI/CD configuration changes |

#### Examples

```bash
# Feature
git commit -m "feat(auth): add wallet connection status indicator"

# Bug fix
git commit -m "fix(booking): validate check-out after check-in date"

# Documentation
git commit -m "docs(readme): update installation steps for v2.0"

# Refactor
git commit -m "refactor(hooks): consolidate wallet logic into useWallet"

# Test
git commit -m "test(api): add integration tests for property endpoints"

# Chore
git commit -m "chore(deps): update stellar-sdk to v12.0.0"
```

### Pull Request Process

1. **Create a branch**
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes**
   - Follow coding standards
   - Write tests for new functionality
   - Update documentation if needed

3. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat(scope): description"
   ```

4. **Push and create PR**
   ```bash
   git push -u origin feat/your-feature-name
   ```

5. **Fill out the PR template**

---

## Coding Standards

### TypeScript

- Use strict mode always
- Prefer `interface` over `type` for public APIs
- Use explicit return types for functions
- Enable and respect ESLint rules

```typescript
// ✅ Good
interface Property {
  id: string;
  title: string;
  pricePerNight: number;
}

function getPropertyById(id: string): Promise<Property | null> {
  return db.properties.findUnique({ where: { id } });
}

// ❌ Bad
interface Property { id: string, title: string, pricePerNight: number }
function getProperty(id: string) { return db.properties.findUnique({ where: { id } }) }
```

### Rust (Smart Contracts)

- Follow `rustfmt` formatting
- Use meaningful variable names
- Add documentation for public functions
- Write unit tests for contract functions

```rust
/// Lists a new property on the platform
///
/// # Arguments
/// * `owner` - The wallet address of the property owner
/// * `title` - Name of the property
/// * `price_per_night` - Price in USDC (8 decimal places)
///
/// # Returns
/// * `u64` - The ID of the newly created property
pub fn list_property(
    env: Env,
    owner: Address,
    title: String,
    price_per_night: i128,
) -> u64 {
    // Implementation
}
```

### Biome

We use Biome for linting and formatting. Run before committing:

```bash
# Format and lint
yarn lint

# Fix auto-fixable issues
yarn lint:fix
```

### React/Next.js

- Use functional components with hooks
- Keep components small and focused
- Extract custom hooks for reusable logic
- Use proper TypeScript types for props

```typescript
// ✅ Good
interface PropertyCardProps {
  property: Property;
  onBook: (id: string) => void;
}

export function PropertyCard({ property, onBook }: PropertyCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{property.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <span>${property.pricePerNight}/night</span>
        <Button onClick={() => onBook(property.id)}>Book</Button>
      </CardContent>
    </Card>
  );
}
```

---

## Testing Requirements

### Coverage Thresholds

| Metric | Minimum |
|--------|---------|
| Statements | 70% |
| Branches | 65% |
| Functions | 70% |
| Lines | 70% |

### Running Tests

```bash
# All tests
yarn test

# Backend tests
cd apps/backend && bun test

# Frontend tests
cd apps/web && yarn test

# Contract tests
cd apps/contracts && cargo test
```

### Test Types

| Type | Location | Run Command |
|------|----------|-------------|
| Unit | `tests/unit/` | `bun test` |
| Integration | `tests/integration/` | `bun test` |
| E2E | `tests/e2e/` | `yarn test:e2e` |

---

## Pull Request Checklist

Before submitting your PR, ensure:

- [ ] Code follows our style guide
- [ ] Tests pass locally
- [ ] New tests added for new functionality
- [ ] Documentation updated (if applicable)
- [ ] Commit messages follow conventional commits
- [ ] Branch is up-to-date with main
- [ ] No merge conflicts

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
Describe testing performed

## Screenshots (if applicable)

## Related Issues
Closes #
```

---

## Release Process

1. **Version Bump**: Update version in `package.json`
2. **Changelog**: Generate changelog from commits
3. **Tag**: Create git tag
4. **Build**: Build all packages
5. **Deploy**: Deploy to production

### Version Scheme

We follow [Semantic Versioning](https://semver.org/):
- `MAJOR` - Breaking changes
- `MINOR` - New features (backward compatible)
- `PATCH` - Bug fixes

---

## Good First Issues

Looking for a way to contribute? Check out issues labeled [`good first issue`](https://github.com/your-org/rentars/labels/good%20first%20issue):

- [Documentation improvements](https://github.com/your-org/rentars/labels/docs)
- [Good first issues](https://github.com/your-org/rentars/labels/good%20first%20issue)
- [Help wanted](https://github.com/your-org/rentars/labels/help%20wanted)

### Beginner-Friendly Tasks

- Fix typos in documentation
- Add missing JSDoc comments
- Write unit tests for uncovered functions
- Improve error messages
- Add TypeScript types to untyped files

---

## Resources

- [GitHub Issues](https://github.com/your-org/rentars/issues)
- [Stellar Documentation](https://developers.stellar.org/docs)
- [Soroban SDK](https://soroban.stellar.org/docs)
- [Next.js Documentation](https://nextjs.org/docs)
- [Supabase Documentation](https://supabase.com/docs)

---

## Questions?

- Open an issue for bugs or feature requests
- Join our community chat (link in README)
- Email: [contact@rentars.io](mailto:contact@rentars.io)

We appreciate your contributions!