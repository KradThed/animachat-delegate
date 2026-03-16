/**
 * Webhook Server
 *
 * Express HTTP server that receives external events (GitLab, GitHub, etc.)
 * and forwards them as trigger_inference messages to the Animachat server.
 */

import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import type { DelegateConnection } from './connection.js';
import type { WebhookEndpoint } from './types.js';

// =============================================================================
// Types
// =============================================================================

interface ParsedPayload {
  context: Record<string, unknown>;
  systemMessage: string;
}

// =============================================================================
// WebhookServer
// =============================================================================

export interface WebhookRateLimitConfig {
  windowMs: number;
  maxPerWindow: number;
}

export class WebhookServer {
  private app: express.Application;
  private httpServer: ReturnType<typeof this.app.listen> | null = null;
  private connection: DelegateConnection;

  // DEL-5: Per-endpoint rate limiting (configurable via delegate.yaml)
  private rateLimits = new Map<string, number[]>();
  private rateWindowMs: number;
  private rateMax: number;

  constructor(connection: DelegateConnection, rateLimitConfig?: WebhookRateLimitConfig) {
    this.connection = connection;
    this.rateWindowMs = rateLimitConfig?.windowMs ?? 60_000;
    this.rateMax = rateLimitConfig?.maxPerWindow ?? 60;
    this.app = express();
    // DEL-6: Capture raw body for HMAC signature verification
    this.app.use(express.json({
      limit: '1mb',
      verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; },
    }));
  }

  /**
   * Start the webhook HTTP server.
   */
  start(port: number, endpoints: WebhookEndpoint[]): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', endpoints: endpoints.length });
    });

    // Register each configured endpoint
    for (const endpoint of endpoints) {
      this.registerEndpoint(endpoint);
    }

    this.httpServer = this.app.listen(port, () => {
      console.log(`[Webhooks] Listening on port ${port}`);
      for (const ep of endpoints) {
        console.log(`[Webhooks]   ${ep.source}: POST ${ep.path}`);
      }
    });
  }

  /**
   * Stop the webhook server.
   */
  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
      console.log('[Webhooks] Server stopped');
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private registerEndpoint(endpoint: WebhookEndpoint): void {
    this.app.post(endpoint.path, (req, res) => {
      // DEL-5: Rate limiting
      const rateKey = `${req.ip}:${endpoint.path}`;
      if (!this.checkRateLimit(rateKey)) {
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
      }

      // Signature verification — DEL-6: use raw body for HMAC
      if (endpoint.secret) {
        const rawBody: Buffer | undefined = (req as any).rawBody;
        // B11: reject if rawBody missing — re-serialization won't match signature bytes
        if (!rawBody) {
          console.warn(`[Webhooks] No raw body available for HMAC verification (${endpoint.source})`);
          res.status(500).json({ error: 'Raw body not captured for signature verification' });
          return;
        }
        const valid = this.verifySignature(
          endpoint.source,
          endpoint.secret,
          rawBody,
          req.headers as Record<string, string>
        );
        if (!valid) {
          console.warn(`[Webhooks] Signature verification failed for ${endpoint.source}`);
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      // Check if delegate is connected
      if (!this.connection.isConnected) {
        console.warn(`[Webhooks] Received ${endpoint.source} event but not connected to server`);
        res.status(503).json({ error: 'Delegate not connected' });
        return;
      }

      // Parse payload — DEL-7: safe JSON.parse
      let body: Record<string, unknown>;
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      } catch {
        res.status(400).json({ error: 'Invalid JSON payload' });
        return;
      }
      const headers = req.headers as Record<string, string>;
      const parsed = this.parsePayload(
        endpoint.source,
        body,
        headers
      );

      const eventId = randomUUID();

      if (this.connection.isMcpl && endpoint.conversation_id) {
        // MCPL mode: use push events with idempotency
        const deliveryId = this.extractDeliveryId(endpoint.source, headers);
        const eventType = this.extractEventType(endpoint.source, headers);

        // E1: Check if push event was accepted by connection (featureSet enforcement)
        const sent = this.connection.sendPushEvent({
          eventId,
          featureSet: `${endpoint.source}_webhook`,  // F8a: source → featureSet
          origin: { server: endpoint.source },        // spec: provenance metadata object
          conversationId: endpoint.conversation_id,
          eventType,
          // B8: spec Section 9.2 requires payload: { content: ContentBlock[] }
          payload: {
            content: [{ type: 'text' as const, text: JSON.stringify(parsed.context) }],
          },
          systemMessage: parsed.systemMessage,
          idempotencyKey: deliveryId || eventId,
        });

        if (sent) {
          console.log(`[Webhooks] Forwarded ${endpoint.source} event as MCPL push ${eventId} (idempotencyKey: ${deliveryId || 'auto'})`);
          res.json({ accepted: true, eventId, mode: 'mcpl' });
        } else {
          console.warn(`[Webhooks] Push event rejected by featureSet enforcement: ${eventId}`);
          res.status(503).json({ accepted: false, eventId, error: 'Feature set not enabled' });
        }
      } else {
        // Legacy mode: use trigger_inference
        this.connection.sendTriggerInference({
          triggerId: eventId,
          source: `${endpoint.source}_webhook`,
          conversationId: endpoint.conversation_id,
          participantId: endpoint.participant_id,
          context: parsed.context,
          systemMessage: parsed.systemMessage,
        });

        console.log(`[Webhooks] Forwarded ${endpoint.source} event as trigger ${eventId}`);
        res.json({ accepted: true, triggerId: eventId, mode: 'legacy' });
      }
    });
  }

  private parsePayload(
    source: string,
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    switch (source) {
      case 'gitlab':
        return this.parseGitLabPayload(body, headers);
      case 'github':
        return this.parseGitHubPayload(body, headers);
      default:
        return this.parseGenericPayload(source, body);
    }
  }

  private parseGitLabPayload(
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    const eventType = headers['x-gitlab-event'] || 'unknown';
    const project = body.project as Record<string, unknown> | undefined;
    const projectName = project?.name || 'unknown';

    // Push event
    if (eventType === 'Push Hook') {
      const ref = (body.ref as string || '').replace('refs/heads/', '');
      const commits = body.commits as Array<Record<string, unknown>> || [];
      const commitSummaries = commits.slice(0, 5).map(c => ({
        id: (c.id as string || '').substring(0, 8),
        message: c.message,
        author: (c.author as Record<string, unknown>)?.name,
      }));

      return {
        context: {
          event: 'push',
          project: projectName,
          branch: ref,
          commits: commitSummaries,
          totalCommits: body.total_commits_count,
          pusher: (body.user_name as string) || 'unknown',
        },
        systemMessage:
          `GitLab push event: ${commits.length} commit(s) pushed to ${ref} in ${projectName} ` +
          `by ${body.user_name || 'unknown'}. Review the changes and provide feedback.`,
      };
    }

    // Merge Request event
    if (eventType === 'Merge Request Hook') {
      const attrs = body.object_attributes as Record<string, unknown> || {};
      return {
        context: {
          event: 'merge_request',
          project: projectName,
          title: attrs.title,
          description: attrs.description,
          sourceBranch: attrs.source_branch,
          targetBranch: attrs.target_branch,
          state: attrs.state,
          action: attrs.action,
          url: attrs.url,
          author: (body.user as Record<string, unknown>)?.name,
        },
        systemMessage:
          `GitLab merge request event in ${projectName}: "${attrs.title}" ` +
          `(${attrs.source_branch} → ${attrs.target_branch}). ` +
          `Action: ${attrs.action}. Review and provide feedback.`,
      };
    }

    // Fallback
    return {
      context: { event: eventType, project: projectName, raw: body },
      systemMessage: `GitLab ${eventType} in ${projectName}. Analyze and respond.`,
    };
  }

  private parseGitHubPayload(
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    const eventType = headers['x-github-event'] || 'unknown';
    const repo = body.repository as Record<string, unknown> | undefined;
    const repoName = (repo?.full_name as string) || 'unknown';

    // Push event
    if (eventType === 'push') {
      const ref = (body.ref as string || '').replace('refs/heads/', '');
      const commits = body.commits as Array<Record<string, unknown>> || [];
      const commitSummaries = commits.slice(0, 5).map(c => ({
        id: (c.id as string || '').substring(0, 8),
        message: c.message,
        author: (c.author as Record<string, unknown>)?.name,
      }));

      return {
        context: {
          event: 'push',
          repo: repoName,
          branch: ref,
          commits: commitSummaries,
          pusher: (body.pusher as Record<string, unknown>)?.name || 'unknown',
        },
        systemMessage:
          `GitHub push: ${commits.length} commit(s) to ${ref} in ${repoName}. ` +
          `Review the changes and provide feedback.`,
      };
    }

    // Pull Request event
    if (eventType === 'pull_request') {
      const pr = body.pull_request as Record<string, unknown> || {};
      const head = pr.head as Record<string, unknown> || {};
      const base = pr.base as Record<string, unknown> || {};
      return {
        context: {
          event: 'pull_request',
          repo: repoName,
          action: body.action,
          title: pr.title,
          body: pr.body,
          sourceBranch: head.ref,
          targetBranch: base.ref,
          url: pr.html_url,
          author: (pr.user as Record<string, unknown>)?.login,
        },
        systemMessage:
          `GitHub PR in ${repoName}: "${pr.title}" (${head.ref} → ${base.ref}). ` +
          `Action: ${body.action}. Review and provide feedback.`,
      };
    }

    // Fallback
    return {
      context: { event: eventType, repo: repoName, action: body.action, raw: body },
      systemMessage: `GitHub ${eventType} in ${repoName}. Analyze and respond.`,
    };
  }

  private parseGenericPayload(
    source: string,
    body: Record<string, unknown>
  ): ParsedPayload {
    return {
      context: { source, payload: body },
      systemMessage:
        `External event received from ${source}. ` +
        `Analyze the payload and respond appropriately.`,
    };
  }

  /**
   * Extract delivery ID from webhook headers for idempotency.
   * Primary key to prevent duplicate processing on webhook retries.
   */
  private extractDeliveryId(source: string, headers: Record<string, string>): string | undefined {
    switch (source) {
      case 'github':
        return headers['x-github-delivery'];
      case 'gitlab':
        return headers['x-gitlab-event-uuid'];
      default:
        return undefined;
    }
  }

  /**
   * Extract event type from webhook headers.
   */
  private extractEventType(source: string, headers: Record<string, string>): string {
    switch (source) {
      case 'github':
        return headers['x-github-event'] || 'unknown';
      case 'gitlab':
        return headers['x-gitlab-event'] || 'unknown';
      default:
        return 'webhook';
    }
  }

  // DEL-5: Sliding window rate limiter
  // D-7: Delete empty entries to prevent unbounded Map growth from unique IPs
  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimits.get(key) || [];
    const recent = timestamps.filter(t => now - t < this.rateWindowMs);
    if (recent.length >= this.rateMax) return false;
    recent.push(now);
    this.rateLimits.set(key, recent);

    // BUG-8 fix: deterministic cleanup when Map exceeds threshold.
    // Previous probabilistic approach (Math.random() < 0.01) could let Map grow
    // unboundedly under DDoS with many unique IPs.
    if (this.rateLimits.size > 100) {
      for (const [k, ts] of this.rateLimits) {
        if (ts.every(t => now - t >= this.rateWindowMs)) {
          this.rateLimits.delete(k);
        }
      }
    }

    return true;
  }

  private verifySignature(
    source: string,
    secret: string,
    body: Buffer,
    headers: Record<string, string>
  ): boolean {
    try {
      if (source === 'gitlab') {
        // DEL-16: Timing-safe GitLab token comparison
        const token = headers['x-gitlab-token'];
        if (!token) return false;
        const tokenBuf = Buffer.from(token);
        const secretBuf = Buffer.from(secret);
        if (tokenBuf.length !== secretBuf.length) return false;
        return timingSafeEqual(tokenBuf, secretBuf);
      }

      if (source === 'github') {
        // DEL-6: GitHub HMAC-SHA256 against raw body bytes
        const signature = headers['x-hub-signature-256'];
        if (!signature) return false;

        const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
        const expectedBuf = Buffer.from(expected);
        const signatureBuf = Buffer.from(signature);

        if (expectedBuf.length !== signatureBuf.length) return false;
        return timingSafeEqual(expectedBuf, signatureBuf);
      }

      // S-4 fix: Unknown sources MUST NOT bypass signature verification.
      // A configured secret implies the user wants webhook auth — silently
      // skipping it would let anyone send unauthenticated payloads.
      console.warn(`[Webhooks] No signature verifier for source "${source}". Rejecting request. Configure source as "gitlab" or "github", or remove the secret.`);
      return false;
    } catch (error) {
      console.error(`[Webhooks] Signature verification error:`, error);
      return false;
    }
  }
}
