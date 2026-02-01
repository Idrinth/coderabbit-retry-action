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

    // Phase 0: Identify all PRs that need a retry
    const prsToRetry = [];

    for (const pr of pullRequests) {
      if (prsToRetry.length >= maxRetries) {
        core.info(`\nReached max retry limit (${maxRetries}). Stopping evaluation.`);
        break;
      }

      prsChecked++;
      core.info(`\n${'='.repeat(50)}`);
      core.info(`Checking PR #${pr.number}: ${pr.title}`);

      // Check branch filter
      const branchName = pr.head.ref;
      if (matchesPattern(branchName, ignoreBranches)) {
        prsSkipped++;
        core.info(`Skipped: Branch "${branchName}" matches ignore pattern`);
        continue;
      }

      // Check label blacklist
      const prLabels = pr.labels.map(label => label.name.toLowerCase());
      const matchedLabel = ignoreLabels.find(ignoreLabel =>
        prLabels.includes(ignoreLabel.toLowerCase())
      );
      if (matchedLabel) {
        prsSkipped++;
        core.info(`Skipped: PR has ignored label "${matchedLabel}"`);
        continue;
      }

      const result = await checkIfRetryNeeded(octokit, {
        owner,
        repo,
        pr,
        cooldownHours,
      });

      if (result.retryNeeded) {
        prsToRetry.push(pr);
        core.info(`Retry needed for PR #${pr.number}`);
      } else {
        prsSkipped++;
        core.info(`Skipped: ${result.reason}`);
      }
    }

    retryCount = prsToRetry.length;

    if (prsToRetry.length > 0) {
      core.info(`\n${'='.repeat(50)}`);
      core.info(`Sending review commands to ${prsToRetry.length} PR(s) in 3 phases (pause, review, resume)...`);

      // Phase 1: Send @coderabbitai pause to all eligible PRs
      core.info(`\nPhase 1: Sending @coderabbitai pause`);
      for (const pr of prsToRetry) {
        if (dryRun) {
          core.info(`[DRY RUN] Would send @coderabbitai pause to PR #${pr.number}`);
        } else {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pr.number,
            body: `@coderabbitai pause`,
          });
          core.info(`Sent @coderabbitai pause to PR #${pr.number}`);
        }
      }

      // Wait 1 minute
      if (!dryRun) {
        core.info(`\nWaiting 60 seconds before next phase...`);
        await sleep(60000);
      }

      // Phase 2: Send info comment + @coderabbitai review to all eligible PRs
      core.info(`\nPhase 2: Sending @coderabbitai review`);
      for (const pr of prsToRetry) {
        if (dryRun) {
          core.info(`[DRY RUN] Would send @coderabbitai review to PR #${pr.number}`);
        } else {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pr.number,
            body: `_Automated retry request due to previous rate limit. Triggered by [CodeRabbit Retry Action](https://github.com/Idrinth/coderabbit-retry-action)._`,
          });
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pr.number,
            body: `@coderabbitai review`,
          });
          core.info(`Sent @coderabbitai review to PR #${pr.number}`);
        }
      }

      // Wait 1 minute
      if (!dryRun) {
        core.info(`\nWaiting 60 seconds before next phase...`);
        await sleep(60000);
      }

      // Phase 3: Send @coderabbitai resume to all eligible PRs
      core.info(`\nPhase 3: Sending @coderabbitai resume`);
      for (const pr of prsToRetry) {
        if (dryRun) {
          core.info(`[DRY RUN] Would send @coderabbitai resume to PR #${pr.number}`);
        } else {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pr.number,
            body: `@coderabbitai resume`,
          });
          core.info(`Sent @coderabbitai resume to PR #${pr.number}`);
        }
      }

      core.info(`\nAll 3 phases complete.`);
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

async function checkIfRetryNeeded(octokit, { owner, repo, pr, cooldownHours }) {
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
    return { retryNeeded: false, reason: 'CodeRabbit already reviewed latest commit' };
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
    return { retryNeeded: false, reason: 'No rate limit comment from CodeRabbit' };
  }

  core.info(`Found rate limit comment from CodeRabbit (${new Date(rateLimitComment.created_at).toISOString()})`);

  // Check cooldown period - look for any of the retry commands posted by this action
  const cooldownTime = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const recentRetryRequest = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.includes('@coderabbitai pause') &&
      new Date(comment.created_at) > cooldownTime
  );

  if (recentRetryRequest) {
    const requestedAt = new Date(recentRetryRequest.created_at);
    return {
      retryNeeded: false,
      reason: `Retry already requested at ${requestedAt.toISOString()} (within ${cooldownHours}h cooldown)`,
    };
  }

  return { retryNeeded: true };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
