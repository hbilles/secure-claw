/**
 * GitHub Service — search repos, manage issues, create PRs, read files.
 *
 * Executes in the Gateway process (not in executor containers) because
 * it needs OAuth tokens, which must never be passed to containers.
 *
 * Uses the GitHub REST API via @octokit/rest.
 *
 * Action classification:
 * - search_repos, list_issues, read_file_github → auto-approve (for own repos)
 * - create_issue, create_pr → require-approval
 */

import type { OAuthStore } from './oauth.js';

// @octokit/rest is ESM-only; use dynamic import in CJS context
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _OctokitCtor: any = null;
async function getOctokitClass(): Promise<any> {
  if (!_OctokitCtor) {
    const mod = await import('@octokit/rest');
    _OctokitCtor = mod.Octokit;
  }
  return _OctokitCtor;
}

// ---------------------------------------------------------------------------
// GitHub Service
// ---------------------------------------------------------------------------

export class GitHubService {
  private oauthStore: OAuthStore;
  private ownRepos: Set<string>;

  constructor(oauthStore: OAuthStore, ownRepos: string[] = []) {
    this.oauthStore = oauthStore;
    this.ownRepos = new Set(ownRepos.map((r) => r.toLowerCase()));
  }

  /**
   * Check if GitHub is connected (has stored token).
   */
  isConnected(): boolean {
    return this.oauthStore.hasToken('github');
  }

  /**
   * Check if a repo is owned by the user (for auto-approve tier).
   */
  isOwnRepo(repo: string): boolean {
    return this.ownRepos.has(repo.toLowerCase());
  }

  /**
   * Get an authenticated Octokit client.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    const tokenData = this.oauthStore.getToken('github');
    if (!tokenData) {
      throw new Error('GitHub not connected. Use /connect github to set up.');
    }

    const Octokit = await getOctokitClass();
    return new Octokit({
      auth: tokenData.accessToken,
    });
  }

  /**
   * Parse "owner/repo" string.
   */
  private parseRepo(repo: string): { owner: string; repo: string } {
    const parts = repo.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
    }
    return { owner: parts[0]!, repo: parts[1]! };
  }

  /**
   * Search GitHub repositories.
   */
  async searchRepos(query: string): Promise<string> {
    const octokit = await this.getClient();

    const response = await octokit.search.repos({
      q: query,
      per_page: 10,
      sort: 'stars',
      order: 'desc',
    });

    const repos = response.data.items;
    if (repos.length === 0) {
      return 'No repositories found matching your query.';
    }

    return repos
      .map(
        (repo: any) =>
          `📦 **${repo.full_name}** ⭐${repo.stargazers_count}\n` +
          `   ${repo.description || '(no description)'}\n` +
          `   Language: ${repo.language || 'unknown'} | ` +
          `Updated: ${new Date(repo.updated_at || '').toLocaleDateString()}\n` +
          `   URL: ${repo.html_url}`,
      )
      .join('\n\n');
  }

  /**
   * List issues for a repository.
   */
  async listIssues(
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<string> {
    const octokit = await this.getClient();
    const { owner, repo: repoName } = this.parseRepo(repo);

    const response = await octokit.issues.listForRepo({
      owner,
      repo: repoName,
      state,
      per_page: 20,
      sort: 'updated',
      direction: 'desc',
    });

    const issues = response.data.filter((i: any) => !i.pull_request);
    if (issues.length === 0) {
      return `No ${state} issues found in ${repo}.`;
    }

    return issues
      .map(
        (issue: any) =>
          `🔖 #${issue.number}: **${issue.title}** [${issue.state}]\n` +
          `   By: ${issue.user?.login || 'unknown'} | ` +
          `Comments: ${issue.comments} | ` +
          `Updated: ${new Date(issue.updated_at).toLocaleDateString()}\n` +
          (issue.labels.length > 0
            ? `   Labels: ${issue.labels.map((l: any) => (typeof l === 'string' ? l : l.name)).join(', ')}\n`
            : '') +
          `   URL: ${issue.html_url}`,
      )
      .join('\n\n');
  }

  /**
   * Create a new issue.
   * Requires approval.
   */
  async createIssue(
    repo: string,
    title: string,
    body: string,
  ): Promise<string> {
    const octokit = await this.getClient();
    const { owner, repo: repoName } = this.parseRepo(repo);

    const response = await octokit.issues.create({
      owner,
      repo: repoName,
      title,
      body,
    });

    return (
      `✅ Issue created successfully.\n` +
      `Title: ${response.data.title}\n` +
      `Number: #${response.data.number}\n` +
      `URL: ${response.data.html_url}`
    );
  }

  /**
   * Create a pull request.
   * Requires approval.
   */
  async createPR(
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<string> {
    const octokit = await this.getClient();
    const { owner, repo: repoName } = this.parseRepo(repo);

    const response = await octokit.pulls.create({
      owner,
      repo: repoName,
      title,
      body,
      head,
      base,
    });

    return (
      `✅ Pull request created successfully.\n` +
      `Title: ${response.data.title}\n` +
      `Number: #${response.data.number}\n` +
      `URL: ${response.data.html_url}`
    );
  }

  /**
   * Read a file from a GitHub repository.
   * Auto-approve for own repos.
   */
  async readFile(repo: string, filePath: string, ref?: string): Promise<string> {
    const octokit = await this.getClient();
    const { owner, repo: repoName } = this.parseRepo(repo);

    const response = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: filePath,
      ref,
    });

    const data = response.data;
    if (Array.isArray(data)) {
      // It's a directory listing
      return data
        .map(
          (item) =>
            `${item.type === 'dir' ? '📁' : '📄'} ${item.name} (${item.type})`,
        )
        .join('\n');
    }

    if ('content' in data && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return `📄 **${filePath}** (${data.size} bytes)\n\n\`\`\`\n${content}\n\`\`\``;
    }

    return `File found but content not available (type: ${data.type}).`;
  }
}
