/**
 * Plain-text fallback renderer. Subscribes to TelemetryBus events
 * and prints [Delegate HH:MM:SS] lines to stderr.
 * Used when TUI is disabled (--no-tui, --quiet, non-TTY, TERM=dumb)
 * or when Ink fails to initialize (Windows terminal fallback).
 */

import type { TelemetryBus } from '../telemetry.js';

export class LogRenderer {
  constructor(bus: TelemetryBus) {
    bus.on('connection_state', (d) => {
      this.log(`State: ${d.state}`);
    });

    bus.on('reconnecting', (d) => {
      this.log(`Reconnecting (attempt ${d.attempt})...`);
    });

    bus.on('tools_loaded', (d) => {
      this.log(`Tools: ${d.tools.map(t => t.name).join(', ')} (${d.tools.length})`);
    });

    bus.on('tool_call_start', (d) => {
      this.log(`\u2192 ${d.tool} [${d.server}] (${d.callId})`);
    });

    bus.on('tool_call_end', (d) => {
      const status = d.ok ? 'ok' : 'ERROR';
      this.log(`\u2190 ${d.tool} ${status} ${d.durationMs}ms`);
    });

    bus.on('setup_step', (d) => {
      const icon = d.status === 'ok' ? '\u2713' : d.status === 'error' ? '\u2717' : '\u2026';
      this.log(`${icon} ${d.key}${d.detail ? ': ' + d.detail : ''}`);
    });

    bus.on('error', (d) => {
      this.log(`ERROR: ${d.message}${d.server ? ` [${d.server}]` : ''}`);
    });

    bus.on('reload_state', (d) => {
      if (d.reloading) this.log('Reloading MCP servers...');
    });

    // Tick: heartbeat line (process lifecycle, includes state)
    bus.on('tick', () => {
      const v = bus.getSnapshotView();
      const icon = v.connectionState === 'connected' ? '\u2713' : '\u26A0';
      const uptime = v.connectedAt
        ? `${Math.floor((Date.now() - v.connectedAt) / 60_000)}m`
        : '\u2014';
      this.log(`${icon} ${v.connectionState} | ${v.tools.length} tools | uptime ${uptime}`);
    });
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    process.stderr.write(`[Delegate ${ts}] ${msg}\n`);
  }
}
