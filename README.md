# CodeRabbit Retry Action

Automatically retry [CodeRabbit](https://coderabbit.ai) reviews when they fail due to rate limiting. This is currently generated using [Claude](https://claude.ai) and merely reviewed by me.

## Why?

CodeRabbit is an excellent AI code review tool, but it can occasionally hit rate limits during high-activity periods. This action monitors your open PRs and automatically requests a re-review when:

1. The latest commit hasn't been reviewed by CodeRabbit
2. CodeRabbit left a comment containing "Rate Limit exceeded"
3. No retry has been requested within the cooldown period

## Usage

### Basic Setup

Create `.github/workflows/coderabbit-retry.yml`:

```yaml
name: CodeRabbit Retry

on:
  schedule:
    - cron: '0 * * * *'  # Run every hour
  workflow_dispatch:      # Allow manual trigger

jobs:
  retry:
    runs-on: ubuntu-latest
    steps:
      - name: Retry CodeRabbit Reviews
        uses: YOUR_USERNAME/coderabbit-retry-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### With All Options

```yaml
name: CodeRabbit Retry

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
    inputs:
      dry-run:
        description: 'Dry run mode'
        type: boolean
        default: false

jobs:
  retry:
    runs-on: ubuntu-latest
    steps:
      - name: Retry CodeRabbit Reviews
        uses: YOUR_USERNAME/coderabbit-retry-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          max-retries: '4'
          cooldown-hours: '2'
          ignore-branches: 'dependabot/*,renovate/*,release/*'
          ignore-labels: 'skip-coderabbit,wip,draft'
          dry-run: ${{ inputs.dry-run || 'false' }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | GitHub token with `pull-requests: write` permission | Yes | - |
| `max-retries` | Maximum retry requests per workflow run | No | `4` |
| `cooldown-hours` | Hours to wait before retrying the same PR | No | `2` |
| `dry-run` | Log actions without posting comments | No | `false` |
| `ignore-branches` | Comma-separated branch patterns to ignore (supports `*` wildcard) | No | `''` |
| `ignore-labels` | Comma-separated labels to ignore (PRs with any of these labels are skipped) | No | `''` |

## Outputs

| Output | Description |
|--------|-------------|
| `retries-requested` | Number of retry comments posted |
| `prs-checked` | Total PRs examined |
| `prs-skipped` | PRs skipped (already reviewed or no rate limit) |

### Using Outputs

```yaml
- name: Retry CodeRabbit Reviews
  id: retry
  uses: YOUR_USERNAME/coderabbit-retry-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Summary
  run: |
    echo "Checked ${{ steps.retry.outputs.prs-checked }} PRs"
    echo "Requested ${{ steps.retry.outputs.retries-requested }} retries"
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    For each open PR                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │ Get latest commit SHA   │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │ CodeRabbit reviewed     │───Yes──▶ Skip PR
              │ this commit?            │
              └─────────────────────────┘
                            │ No
                            ▼
              ┌─────────────────────────┐
              │ "Rate Limit exceeded"   │───No───▶ Skip PR
              │ comment exists?         │
              └─────────────────────────┘
                            │ Yes
                            ▼
              ┌─────────────────────────┐
              │ Retry requested within  │───Yes──▶ Skip PR
              │ cooldown period?        │
              └─────────────────────────┘
                            │ No
                            ▼
              ┌─────────────────────────┐
              │ Post @coderabbitai      │
              │ review comment          │
              └─────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │ Max retries reached?    │───Yes──▶ Stop
              └─────────────────────────┘
                            │ No
                            ▼
                    Next PR...
```

## Permissions

The action requires these permissions:

```yaml
permissions:
  pull-requests: write
  contents: read
```

## Development

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

> **Important**: Always run `npm run build` before committing. The `dist/` folder must be checked in for the action to work.

### Test Locally

Use [act](https://github.com/nektos/act) to test locally:

```bash
act schedule -j retry
```

## FAQ

### Why use a cooldown period?

To prevent spamming PRs with retry requests if CodeRabbit continues to be rate limited. The default 2-hour cooldown balances responsiveness with avoiding noise.

### Can I use a PAT instead of GITHUB_TOKEN?

Yes, if you need the action to trigger other workflows:

```yaml
with:
  github-token: ${{ secrets.PAT_TOKEN }}
```

### How do I know if it's working?

1. Check the workflow run logs in the Actions tab
2. Enable dry-run mode first to see what would happen
3. Look for the action's comments on your PRs

## License

MIT
