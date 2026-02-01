const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const maxRetries = parseInt(core.getInput('max-retries')) || 4;
    const cooldownHours = parseInt(core.getInput('cooldown-hours')) || 2;
    const dryRun = core.getInput('dry-run') === 'true';
    const ignoreBranches = parseCommaSeparated(core.getInput('ignore-branches'));
    const ignoreLabels = parseCommaSeparated(core.getInput('ignore-labels'));

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    let retryCount = 0;
    let prsChecked = 0;
    let prsSkipped = 0;

    core.info(`Configuration:`);
    core.info(`  Max retries: ${maxRetries}`);
    core.info(`  Cooldown: ${cooldownHours} hours`);
    core.info(`  Dry run: ${dryRun}`);
    core.info(`  Ignore branches: ${ignoreBranches.length ? ignoreBranches.join(', ') : '(none)'}`);
    core.info(`  Ignore labels: ${ignoreLabels.length ? ignoreLabels.join(', ') : '(none)'}`);
    core.info(`  Repository: ${owner}/${repo}`);
    core.info('');

    // Get all open PRs
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
    });

    core.info(`Found ${pullRequests.length} open PRs`);

    for (const pr of pullRequests) {
      if (retryCount >= maxRetries) {
        core.info(`\nReached max retry limit (${maxRetries}). Stopping.`);
        break;
      }

      prsChecked++;
      core.info(`\n${'='.repeat(50)}`);
      core.info(`Checking PR #${pr.number}: ${pr.title}`);

      // Check branch filter
      const branchName = pr.head.ref;
      if (matchesPattern(branchName, ignoreBranches)) {
        prsSkipped++;
        core.info(`⏭️ Skipped: Branch "${branchName}" matches ignore pattern`);
        continue;
      }

      // Check label blacklist
      const prLabels = pr.labels.map(label => label.name.toLowerCase());
      const matchedLabel = ignoreLabels.find(ignoreLabel => 
        prLabels.includes(ignoreLabel.toLowerCase())
      );
      if (matchedLabel) {
        prsSkipped++;
        core.info(`⏭️ Skipped: PR has ignored label "${matchedLabel}"`);
        continue;
      }

      const result = await checkAndRetryPR(octokit, {
        owner,
        repo,
        pr,
        cooldownHours,
        dryRun,
      });

      if (result.retryRequested) {
        retryCount++;
        core.info(`✅ Retry requested (${retryCount}/${maxRetries})`);
      } else {
        prsSkipped++;
        core.info(`⏭️ Skipped: ${result.reason}`);
      }
    }

    // Set outputs
    core.setOutput('retries-requested', retryCount);
    core.setOutput('prs-checked', prsChecked);
    core.setOutput('prs-skipped', prsSkipped);

    core.info(`\n${'='.repeat(50)}`);
    core.info(`Summary:`);
    core.info(`  PRs checked: ${prsChecked}`);
    core.info(`  PRs skipped: ${prsSkipped}`);
    core.info(`  Retries requested: ${retryCount}`);

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

async function checkAndRetryPR(octokit, { owner, repo, pr, cooldownHours, dryRun }) {
  const latestCommitSha = pr.head.sha;
  core.info(`Latest commit: ${latestCommitSha.substring(0, 7)}`);

  // Check if CodeRabbit has reviewed the latest commit
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: pr.number,
  });

  const coderabbitReview = reviews.find(
    (review) =>
      review.user?.login?.toLowerCase() === 'coderabbitai[bot]' &&
      review.commit_id === latestCommitSha &&
      !review.body?.toLowerCase().includes('exceeded the limit')
  );

  if (coderabbitReview) {
    return { retryRequested: false, reason: 'CodeRabbit already reviewed latest commit' };
  }

  // Get issue comments
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pr.number,
  });

  // Get review comments
  const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pr.number,
  });

  const allComments = [...comments, ...reviewComments];

  // Check for rate limit message from CodeRabbit
  // Also check review bodies, since CodeRabbit may post rate limit messages
  // as the summary body of a PR review (not as a comment)
  const rateLimitComment = allComments.find(
    (comment) =>
      comment.user?.login?.toLowerCase() === 'coderabbitai[bot]' &&
      comment.body?.toLowerCase().includes('exceeded the limit')
  ) || reviews.find(
    (review) =>
      review.user?.login?.toLowerCase() === 'coderabbitai[bot]' &&
      review.body?.toLowerCase().includes('exceeded the limit')
  );

  if (!rateLimitComment) {
    return { retryRequested: false, reason: 'No rate limit comment from CodeRabbit' };
  }

  core.info(`Found rate limit comment from CodeRabbit (${new Date(rateLimitComment.created_at).toISOString()})`);

  // Check cooldown period
  const cooldownTime = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const recentRetryRequest = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.includes('@coderabbitai review') &&
      new Date(comment.created_at) > cooldownTime
  );

  if (recentRetryRequest) {
    const requestedAt = new Date(recentRetryRequest.created_at);
    return {
      retryRequested: false,
      reason: `Retry already requested at ${requestedAt.toISOString()} (within ${cooldownHours}h cooldown)`,
    };
  }

  // Request CodeRabbit review
  if (dryRun) {
    core.info(`[DRY RUN] Would request CodeRabbit review for PR #${pr.number}`);
    return { retryRequested: true, reason: 'Dry run - no comment posted' };
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: `@coderabbitai review

_Automated retry request due to previous rate limit. Triggered by [CodeRabbit Retry Action](https://github.com/Idrinth/coderabbit-retry-action)._`,
  });

  return { retryRequested: true, reason: 'Retry requested successfully' };
}

/**
 * Parse comma-separated string into array, trimming whitespace
 */
function parseCommaSeparated(input) {
  if (!input || !input.trim()) {
    return [];
  }
  return input.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Check if a string matches any of the patterns (supports * wildcard)
 */
function matchesPattern(str, patterns) {
  if (!patterns.length) return false;
  
  return patterns.some(pattern => {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
      .replace(/\*/g, '.*');                   // Convert * to .*
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(str);
  });
}

run();
