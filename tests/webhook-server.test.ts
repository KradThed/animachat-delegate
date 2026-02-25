import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';

// Mock express before importing WebhookServer
vi.mock('express', () => {
  const mockApp = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    listen: vi.fn(),
  };
  const expressFn: any = () => mockApp;
  expressFn.json = () => vi.fn();
  expressFn.text = () => vi.fn();
  return { default: expressFn };
});

import { WebhookServer } from '../src/webhook-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockConnection() {
  return {
    isConnected: true,
    isMcpl: false,
    sendTriggerInference: vi.fn(),
    sendPushEvent: vi.fn(),
  } as any;
}

function createServer(connectionOverrides: Record<string, unknown> = {}) {
  const connection = { ...createMockConnection(), ...connectionOverrides };
  const server = new WebhookServer(connection);
  return server;
}

/**
 * Compute the GitHub HMAC-SHA256 signature for a given body and secret.
 */
function computeGitHubSignature(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhookServer', () => {
  let server: WebhookServer;

  beforeEach(() => {
    server = createServer();
  });

  // =========================================================================
  // verifySignature
  // =========================================================================

  describe('verifySignature', () => {
    const verify = (
      source: string,
      secret: string,
      body: string,
      headers: Record<string, string>,
    ) => (server as any).verifySignature(source, secret, body, headers);

    // ---- GitHub HMAC ----

    it('returns true for a valid GitHub HMAC-SHA256 signature', () => {
      const body = '{"action":"opened"}';
      const secret = 'gh-webhook-secret';
      const signature = computeGitHubSignature(body, secret);

      const result = verify('github', secret, body, {
        'x-hub-signature-256': signature,
      });

      expect(result).toBe(true);
    });

    it('returns false for an invalid GitHub HMAC-SHA256 signature', () => {
      const body = '{"action":"opened"}';
      const secret = 'gh-webhook-secret';
      const wrongSignature = computeGitHubSignature(body, 'wrong-secret');

      const result = verify('github', secret, body, {
        'x-hub-signature-256': wrongSignature,
      });

      expect(result).toBe(false);
    });

    it('returns false when the x-hub-signature-256 header is missing for GitHub', () => {
      const result = verify('github', 'secret', '{}', {});

      expect(result).toBe(false);
    });

    it('returns false when the GitHub signature has a different length', () => {
      const body = '{"test":true}';
      const secret = 'my-secret';
      // Provide a signature that is obviously a different length
      const result = verify('github', secret, body, {
        'x-hub-signature-256': 'sha256=tooshort',
      });

      expect(result).toBe(false);
    });

    it('returns false for a completely garbled GitHub signature', () => {
      const body = '{"push":true}';
      const secret = 'correct-secret';
      const correctSig = computeGitHubSignature(body, secret);
      // Flip a character in the middle of the hex digest
      const garbled =
        correctSig.substring(0, 10) + 'ff' + correctSig.substring(12);

      const result = verify('github', secret, body, {
        'x-hub-signature-256': garbled,
      });

      // If lengths match but content differs, timingSafeEqual returns false
      expect(result).toBe(false);
    });

    // ---- GitLab token ----

    it('returns true when the GitLab token matches the secret', () => {
      const result = verify('gitlab', 'my-gitlab-token', '', {
        'x-gitlab-token': 'my-gitlab-token',
      });

      expect(result).toBe(true);
    });

    it('returns false when the GitLab token does not match the secret', () => {
      const result = verify('gitlab', 'expected-token', '', {
        'x-gitlab-token': 'wrong-token',
      });

      expect(result).toBe(false);
    });

    it('returns false when the x-gitlab-token header is missing', () => {
      const result = verify('gitlab', 'my-token', '', {});

      expect(result).toBe(false);
    });

    // ---- Unknown source ----

    it('returns true for an unknown source (skips verification)', () => {
      const result = verify('bitbucket', 'any-secret', '{}', {});

      expect(result).toBe(true);
    });

    it('returns true for a custom/generic source (skips verification)', () => {
      const result = verify('custom-ci', 'secret', '{"build":"ok"}', {});

      expect(result).toBe(true);
    });

    // ---- Error handling ----

    it('returns false when an error is thrown internally', () => {
      // Pass null as body to provoke an error in createHmac().update()
      const result = verify('github', 'secret', null as any, {
        'x-hub-signature-256': 'sha256=abc',
      });

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // parsePayload (dispatch to source-specific parsers)
  // =========================================================================

  describe('parsePayload', () => {
    const parse = (
      source: string,
      body: Record<string, unknown>,
      headers: Record<string, string>,
    ) => (server as any).parsePayload(source, body, headers);

    it('dispatches to parseGitLabPayload for gitlab source', () => {
      const result = parse(
        'gitlab',
        { project: { name: 'my-proj' } },
        { 'x-gitlab-event': 'Pipeline Hook' },
      );

      expect(result.context.event).toBe('Pipeline Hook');
      expect(result.context.project).toBe('my-proj');
    });

    it('dispatches to parseGitHubPayload for github source', () => {
      const result = parse(
        'github',
        { repository: { full_name: 'org/repo' } },
        { 'x-github-event': 'issues' },
      );

      expect(result.context.event).toBe('issues');
      expect(result.context.repo).toBe('org/repo');
    });

    it('dispatches to parseGenericPayload for unknown sources', () => {
      const result = parse('jenkins', { build: 42 }, {});

      expect(result.context.source).toBe('jenkins');
      expect(result.context.payload).toEqual({ build: 42 });
    });
  });

  // =========================================================================
  // parseGitLabPayload
  // =========================================================================

  describe('parseGitLabPayload', () => {
    const parseGitLab = (
      body: Record<string, unknown>,
      headers: Record<string, string>,
    ) => (server as any).parseGitLabPayload(body, headers);

    // ---- Push Hook ----

    it('parses a Push Hook with branch, commits, pusher, and project', () => {
      const body = {
        ref: 'refs/heads/main',
        user_name: 'alice',
        total_commits_count: 2,
        project: { name: 'backend' },
        commits: [
          {
            id: 'abcdef1234567890',
            message: 'fix: resolve null check',
            author: { name: 'Alice' },
          },
          {
            id: '1234567890abcdef',
            message: 'chore: update deps',
            author: { name: 'Bob' },
          },
        ],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.event).toBe('push');
      expect(result.context.project).toBe('backend');
      expect(result.context.branch).toBe('main');
      expect(result.context.pusher).toBe('alice');
      expect(result.context.totalCommits).toBe(2);
      expect(result.context.commits).toHaveLength(2);
      expect(result.systemMessage).toContain('GitLab push event');
      expect(result.systemMessage).toContain('2 commit(s)');
      expect(result.systemMessage).toContain('main');
      expect(result.systemMessage).toContain('backend');
      expect(result.systemMessage).toContain('alice');
    });

    it('strips refs/heads/ prefix from the branch ref', () => {
      const body = {
        ref: 'refs/heads/feature/my-branch',
        user_name: 'dev',
        project: { name: 'app' },
        commits: [],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.branch).toBe('feature/my-branch');
    });

    it('limits commit summaries to 5 entries', () => {
      const commits = Array.from({ length: 8 }, (_, i) => ({
        id: `commit${i}abcdef1234`,
        message: `commit ${i}`,
        author: { name: `dev${i}` },
      }));

      const body = {
        ref: 'refs/heads/main',
        user_name: 'dev',
        project: { name: 'app' },
        commits,
        total_commits_count: 8,
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.commits).toHaveLength(5);
    });

    it('truncates commit ids to 8 characters', () => {
      const body = {
        ref: 'refs/heads/main',
        user_name: 'dev',
        project: { name: 'app' },
        commits: [
          {
            id: 'abcdef1234567890abcdef1234567890abcdef12',
            message: 'long id commit',
            author: { name: 'Dev' },
          },
        ],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.commits[0].id).toBe('abcdef12');
      expect(result.context.commits[0].id).toHaveLength(8);
    });

    it('handles Push Hook with empty commits array', () => {
      const body = {
        ref: 'refs/heads/main',
        user_name: 'dev',
        project: { name: 'app' },
        commits: [],
        total_commits_count: 0,
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.commits).toEqual([]);
      expect(result.systemMessage).toContain('0 commit(s)');
    });

    it('defaults pusher to "unknown" when user_name is missing', () => {
      const body = {
        ref: 'refs/heads/main',
        project: { name: 'app' },
        commits: [],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.pusher).toBe('unknown');
      expect(result.systemMessage).toContain('unknown');
    });

    // ---- Merge Request Hook ----

    it('parses a Merge Request Hook with title, branches, action, and author', () => {
      const body = {
        project: { name: 'frontend' },
        user: { name: 'Charlie' },
        object_attributes: {
          title: 'Add dark mode',
          description: 'Implements dark mode toggle',
          source_branch: 'feature/dark-mode',
          target_branch: 'main',
          state: 'opened',
          action: 'open',
          url: 'https://gitlab.com/org/frontend/-/merge_requests/42',
        },
      };
      const headers = { 'x-gitlab-event': 'Merge Request Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.event).toBe('merge_request');
      expect(result.context.project).toBe('frontend');
      expect(result.context.title).toBe('Add dark mode');
      expect(result.context.description).toBe('Implements dark mode toggle');
      expect(result.context.sourceBranch).toBe('feature/dark-mode');
      expect(result.context.targetBranch).toBe('main');
      expect(result.context.state).toBe('opened');
      expect(result.context.action).toBe('open');
      expect(result.context.url).toBe(
        'https://gitlab.com/org/frontend/-/merge_requests/42',
      );
      expect(result.context.author).toBe('Charlie');
      expect(result.systemMessage).toContain('GitLab merge request event');
      expect(result.systemMessage).toContain('frontend');
      expect(result.systemMessage).toContain('Add dark mode');
      expect(result.systemMessage).toContain('feature/dark-mode');
      expect(result.systemMessage).toContain('main');
      expect(result.systemMessage).toContain('open');
    });

    it('handles Merge Request Hook with missing user', () => {
      const body = {
        project: { name: 'app' },
        object_attributes: {
          title: 'Fix bug',
          source_branch: 'fix/bug',
          target_branch: 'develop',
          action: 'update',
        },
      };
      const headers = { 'x-gitlab-event': 'Merge Request Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.author).toBeUndefined();
    });

    // ---- Unknown / fallback events ----

    it('returns a fallback payload for unknown GitLab events', () => {
      const body = {
        project: { name: 'infra' },
        pipeline: { status: 'success' },
      };
      const headers = { 'x-gitlab-event': 'Pipeline Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.event).toBe('Pipeline Hook');
      expect(result.context.project).toBe('infra');
      expect(result.context.raw).toEqual(body);
      expect(result.systemMessage).toContain('GitLab Pipeline Hook');
      expect(result.systemMessage).toContain('infra');
    });

    it('defaults project name to "unknown" when project is missing', () => {
      const body = {};
      const headers = { 'x-gitlab-event': 'Note Hook' };

      const result = parseGitLab(body, headers);

      expect(result.context.project).toBe('unknown');
    });

    it('defaults event type to "unknown" when header is missing', () => {
      const body = { project: { name: 'app' } };
      const headers = {} as Record<string, string>;

      const result = parseGitLab(body, headers);

      expect(result.context.event).toBe('unknown');
      expect(result.systemMessage).toContain('GitLab unknown');
    });
  });

  // =========================================================================
  // parseGitHubPayload
  // =========================================================================

  describe('parseGitHubPayload', () => {
    const parseGitHub = (
      body: Record<string, unknown>,
      headers: Record<string, string>,
    ) => (server as any).parseGitHubPayload(body, headers);

    // ---- push ----

    it('parses a push event with branch, commits, repo, and pusher', () => {
      const body = {
        ref: 'refs/heads/develop',
        pusher: { name: 'alice' },
        repository: { full_name: 'org/backend' },
        commits: [
          {
            id: 'abc12345deadbeef',
            message: 'feat: add endpoint',
            author: { name: 'Alice' },
          },
          {
            id: 'def67890cafebabe',
            message: 'test: add tests',
            author: { name: 'Bob' },
          },
        ],
      };
      const headers = { 'x-github-event': 'push' };

      const result = parseGitHub(body, headers);

      expect(result.context.event).toBe('push');
      expect(result.context.repo).toBe('org/backend');
      expect(result.context.branch).toBe('develop');
      expect(result.context.pusher).toBe('alice');
      expect(result.context.commits).toHaveLength(2);
      expect(result.context.commits[0].id).toBe('abc12345');
      expect(result.context.commits[0].message).toBe('feat: add endpoint');
      expect(result.context.commits[0].author).toBe('Alice');
      expect(result.systemMessage).toContain('GitHub push');
      expect(result.systemMessage).toContain('2 commit(s)');
      expect(result.systemMessage).toContain('develop');
      expect(result.systemMessage).toContain('org/backend');
    });

    it('strips refs/heads/ from the push ref', () => {
      const body = {
        ref: 'refs/heads/feature/auth',
        pusher: { name: 'dev' },
        repository: { full_name: 'org/app' },
        commits: [],
      };
      const headers = { 'x-github-event': 'push' };

      const result = parseGitHub(body, headers);

      expect(result.context.branch).toBe('feature/auth');
    });

    it('limits commit summaries to 5 entries for push', () => {
      const commits = Array.from({ length: 7 }, (_, i) => ({
        id: `id${i}abcdef12345678`,
        message: `msg ${i}`,
        author: { name: `dev${i}` },
      }));

      const body = {
        ref: 'refs/heads/main',
        pusher: { name: 'dev' },
        repository: { full_name: 'org/app' },
        commits,
      };
      const headers = { 'x-github-event': 'push' };

      const result = parseGitHub(body, headers);

      expect(result.context.commits).toHaveLength(5);
    });

    it('defaults pusher to "unknown" when pusher.name is missing', () => {
      const body = {
        ref: 'refs/heads/main',
        repository: { full_name: 'org/app' },
        commits: [],
      };
      const headers = { 'x-github-event': 'push' };

      const result = parseGitHub(body, headers);

      expect(result.context.pusher).toBe('unknown');
    });

    // ---- pull_request ----

    it('parses a pull_request event with title, branches, action, and author', () => {
      const body = {
        action: 'opened',
        repository: { full_name: 'org/frontend' },
        pull_request: {
          title: 'Implement search',
          body: 'Adds full-text search capability',
          html_url: 'https://github.com/org/frontend/pull/99',
          user: { login: 'charlie' },
          head: { ref: 'feature/search' },
          base: { ref: 'main' },
        },
      };
      const headers = { 'x-github-event': 'pull_request' };

      const result = parseGitHub(body, headers);

      expect(result.context.event).toBe('pull_request');
      expect(result.context.repo).toBe('org/frontend');
      expect(result.context.action).toBe('opened');
      expect(result.context.title).toBe('Implement search');
      expect(result.context.body).toBe('Adds full-text search capability');
      expect(result.context.sourceBranch).toBe('feature/search');
      expect(result.context.targetBranch).toBe('main');
      expect(result.context.url).toBe(
        'https://github.com/org/frontend/pull/99',
      );
      expect(result.context.author).toBe('charlie');
      expect(result.systemMessage).toContain('GitHub PR');
      expect(result.systemMessage).toContain('org/frontend');
      expect(result.systemMessage).toContain('Implement search');
      expect(result.systemMessage).toContain('feature/search');
      expect(result.systemMessage).toContain('main');
      expect(result.systemMessage).toContain('opened');
    });

    it('handles pull_request with missing user login', () => {
      const body = {
        action: 'closed',
        repository: { full_name: 'org/app' },
        pull_request: {
          title: 'Fix crash',
          head: { ref: 'fix/crash' },
          base: { ref: 'main' },
        },
      };
      const headers = { 'x-github-event': 'pull_request' };

      const result = parseGitHub(body, headers);

      expect(result.context.author).toBeUndefined();
    });

    // ---- Unknown / fallback events ----

    it('returns a fallback payload for unknown GitHub events', () => {
      const body = {
        action: 'created',
        repository: { full_name: 'org/repo' },
        issue: { title: 'Bug report' },
      };
      const headers = { 'x-github-event': 'issues' };

      const result = parseGitHub(body, headers);

      expect(result.context.event).toBe('issues');
      expect(result.context.repo).toBe('org/repo');
      expect(result.context.action).toBe('created');
      expect(result.context.raw).toEqual(body);
      expect(result.systemMessage).toContain('GitHub issues');
      expect(result.systemMessage).toContain('org/repo');
    });

    it('defaults repo name to "unknown" when repository is missing', () => {
      const body = {};
      const headers = { 'x-github-event': 'ping' };

      const result = parseGitHub(body, headers);

      expect(result.context.repo).toBe('unknown');
    });

    it('defaults event type to "unknown" when header is missing', () => {
      const body = { repository: { full_name: 'org/repo' } };
      const headers = {} as Record<string, string>;

      const result = parseGitHub(body, headers);

      expect(result.context.event).toBe('unknown');
      expect(result.systemMessage).toContain('GitHub unknown');
    });
  });

  // =========================================================================
  // parseGenericPayload
  // =========================================================================

  describe('parseGenericPayload', () => {
    const parseGeneric = (source: string, body: Record<string, unknown>) =>
      (server as any).parseGenericPayload(source, body);

    it('returns source and payload in context', () => {
      const payload = { build_id: 123, status: 'success' };
      const result = parseGeneric('jenkins', payload);

      expect(result.context.source).toBe('jenkins');
      expect(result.context.payload).toEqual(payload);
    });

    it('includes a generic system message mentioning the source', () => {
      const result = parseGeneric('slack', { text: 'hello' });

      expect(result.systemMessage).toBe(
        'External event received from slack. Analyze the payload and respond appropriately.',
      );
    });

    it('preserves the full body object as payload', () => {
      const body = {
        nested: { deep: { value: 42 } },
        list: [1, 2, 3],
      };
      const result = parseGeneric('custom', body);

      expect(result.context.payload).toEqual(body);
      expect(result.context.payload.nested.deep.value).toBe(42);
    });
  });

  // =========================================================================
  // extractDeliveryId
  // =========================================================================

  describe('extractDeliveryId', () => {
    const extractId = (source: string, headers: Record<string, string>) =>
      (server as any).extractDeliveryId(source, headers);

    it('returns x-github-delivery header for GitHub source', () => {
      const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const result = extractId('github', { 'x-github-delivery': id });

      expect(result).toBe(id);
    });

    it('returns x-gitlab-event-uuid header for GitLab source', () => {
      const uuid = 'f1e2d3c4-b5a6-7890-1234-567890abcdef';
      const result = extractId('gitlab', { 'x-gitlab-event-uuid': uuid });

      expect(result).toBe(uuid);
    });

    it('returns undefined for unknown source', () => {
      const result = extractId('bitbucket', {
        'x-github-delivery': 'should-not-be-used',
      });

      expect(result).toBeUndefined();
    });

    it('returns undefined for GitHub when the header is absent', () => {
      const result = extractId('github', {});

      expect(result).toBeUndefined();
    });

    it('returns undefined for GitLab when the header is absent', () => {
      const result = extractId('gitlab', {});

      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // extractEventType
  // =========================================================================

  describe('extractEventType', () => {
    const extractType = (source: string, headers: Record<string, string>) =>
      (server as any).extractEventType(source, headers);

    it('returns x-github-event header value for GitHub source', () => {
      const result = extractType('github', {
        'x-github-event': 'pull_request',
      });

      expect(result).toBe('pull_request');
    });

    it('returns x-gitlab-event header value for GitLab source', () => {
      const result = extractType('gitlab', {
        'x-gitlab-event': 'Push Hook',
      });

      expect(result).toBe('Push Hook');
    });

    it('returns "unknown" for GitHub when the header is missing', () => {
      const result = extractType('github', {});

      expect(result).toBe('unknown');
    });

    it('returns "unknown" for GitLab when the header is missing', () => {
      const result = extractType('gitlab', {});

      expect(result).toBe('unknown');
    });

    it('returns "webhook" for unknown sources', () => {
      const result = extractType('bitbucket', {});

      expect(result).toBe('webhook');
    });

    it('returns "webhook" for custom sources regardless of headers', () => {
      const result = extractType('custom-ci', {
        'x-github-event': 'push',
        'x-gitlab-event': 'Push Hook',
      });

      expect(result).toBe('webhook');
    });
  });

  // =========================================================================
  // Edge cases / cross-cutting concerns
  // =========================================================================

  describe('edge cases', () => {
    it('verifySignature: GitHub with empty body produces a valid HMAC', () => {
      const body = '';
      const secret = 'empty-body-secret';
      const signature = computeGitHubSignature(body, secret);

      const result = (server as any).verifySignature('github', secret, body, {
        'x-hub-signature-256': signature,
      });

      expect(result).toBe(true);
    });

    it('verifySignature: GitLab with empty string token does not match empty secret', () => {
      // The method checks `if (!token) return false` first, but empty string
      // is falsy, so it would return false. Let's verify.
      const result = (server as any).verifySignature('gitlab', '', '', {
        'x-gitlab-token': '',
      });

      // Empty string is falsy, so `!token` is true, returns false
      expect(result).toBe(false);
    });

    it('parseGitLabPayload: commit with empty id produces empty string', () => {
      const body = {
        ref: 'refs/heads/main',
        user_name: 'dev',
        project: { name: 'app' },
        commits: [{ id: '', message: 'no id', author: { name: 'Dev' } }],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = (server as any).parseGitLabPayload(body, headers);

      expect(result.context.commits[0].id).toBe('');
    });

    it('parseGitHubPayload: push with tag ref does not strip prefix', () => {
      const body = {
        ref: 'refs/tags/v1.0.0',
        pusher: { name: 'release-bot' },
        repository: { full_name: 'org/app' },
        commits: [],
      };
      const headers = { 'x-github-event': 'push' };

      const result = (server as any).parseGitHubPayload(body, headers);

      // Only 'refs/heads/' is replaced, not 'refs/tags/'
      expect(result.context.branch).toBe('refs/tags/v1.0.0');
    });

    it('parseGitLabPayload: push with tag ref does not strip prefix', () => {
      const body = {
        ref: 'refs/tags/v2.0.0',
        user_name: 'dev',
        project: { name: 'lib' },
        commits: [],
      };
      const headers = { 'x-gitlab-event': 'Push Hook' };

      const result = (server as any).parseGitLabPayload(body, headers);

      expect(result.context.branch).toBe('refs/tags/v2.0.0');
    });

    it('parseGitLabPayload: merge request with empty object_attributes', () => {
      const body = {
        project: { name: 'app' },
      };
      const headers = { 'x-gitlab-event': 'Merge Request Hook' };

      const result = (server as any).parseGitLabPayload(body, headers);

      expect(result.context.event).toBe('merge_request');
      expect(result.context.title).toBeUndefined();
      expect(result.context.sourceBranch).toBeUndefined();
      expect(result.context.targetBranch).toBeUndefined();
    });

    it('parseGitHubPayload: pull_request with empty pull_request object', () => {
      const body = {
        action: 'labeled',
        repository: { full_name: 'org/repo' },
      };
      const headers = { 'x-github-event': 'pull_request' };

      const result = (server as any).parseGitHubPayload(body, headers);

      expect(result.context.event).toBe('pull_request');
      expect(result.context.title).toBeUndefined();
      expect(result.context.sourceBranch).toBeUndefined();
      expect(result.context.targetBranch).toBeUndefined();
    });
  });

  // =========================================================================
  // Configurable rate limits (Feature 1)
  // =========================================================================

  describe('configurable rate limits', () => {
    it('uses default rate limits when no config is provided', () => {
      const srv = new WebhookServer(createMockConnection());
      expect((srv as any).rateWindowMs).toBe(60_000);
      expect((srv as any).rateMax).toBe(60);
    });

    it('accepts custom rate limit config', () => {
      const srv = new WebhookServer(createMockConnection(), {
        windowMs: 10_000,
        maxPerWindow: 5,
      });
      expect((srv as any).rateWindowMs).toBe(10_000);
      expect((srv as any).rateMax).toBe(5);
    });

    it('enforces custom maxPerWindow limit', () => {
      const srv = new WebhookServer(createMockConnection(), {
        windowMs: 60_000,
        maxPerWindow: 3,
      });
      const check = (key: string) => (srv as any).checkRateLimit(key);

      expect(check('ip:path')).toBe(true);  // 1
      expect(check('ip:path')).toBe(true);  // 2
      expect(check('ip:path')).toBe(true);  // 3
      expect(check('ip:path')).toBe(false); // 4 → blocked
    });

    it('different keys have independent limits', () => {
      const srv = new WebhookServer(createMockConnection(), {
        windowMs: 60_000,
        maxPerWindow: 1,
      });
      const check = (key: string) => (srv as any).checkRateLimit(key);

      expect(check('ip1:path')).toBe(true);
      expect(check('ip1:path')).toBe(false); // blocked
      expect(check('ip2:path')).toBe(true);  // different key → ok
    });
  });
});
