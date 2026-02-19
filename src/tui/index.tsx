/**
 * Ink-based TUI dashboard for the delegate.
 * Renders to stderr. Stdout stays clean for structured output.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { TelemetryBus, SnapshotView, ToolCallEntry } from '../telemetry.js';

// ── Props ──────────────────────────────────────────────────────────

interface AppProps {
  bus: TelemetryBus;
  reload: () => Promise<void>;
  shutdown: () => void;
}

// ── Main App ───────────────────────────────────────────────────────

export default function App({ bus, reload, shutdown }: AppProps) {
  const [view, setView] = useState<SnapshotView>(() => bus.getSnapshotView());
  const [showTools, setShowTools] = useState(false);
  const { exit } = useApp();

  // Subscribe to all state-change events via type-safe subscribeAll
  useEffect(() => {
    const update = () => setView(bus.getSnapshotView());
    const unsub = bus.subscribeAll(update);
    return unsub;
  }, [bus]);

  // 500ms local timer for live uptime + in-flight elapsed
  useEffect(() => {
    const t = setInterval(() => setView(bus.getSnapshotView()), 500);
    return () => clearInterval(t);
  }, [bus]);

  useInput((input, key) => {
    // Ink 6 kitty protocol sends press + release events; ignore releases
    if (key.eventType === 'release') return;

    if (input === 'q' || (key.ctrl && input === 'c')) {
      shutdown();
      exit();
    }
    if (input === 'r') reload();
    if (input === '?') setShowTools((t) => !t);
    if (input === 'c') bus.clearRecent();
  });

  return (
    <Box flexDirection="column">
      <StatusBar view={view} />
      <SetupChecklist view={view} />
      {showTools && <ToolOverlay view={view} />}
      <RecentCalls view={view} />
      <KeybindingsBar reloading={view.reloading} />
    </Box>
  );
}

// ── StatusBar ──────────────────────────────────────────────────────

function StatusBar({ view }: { view: SnapshotView }) {
  const dotColor =
    view.connectionState === 'connected'
      ? 'green'
      : view.connectionState === 'reconnecting'
        ? 'yellow'
        : 'red';

  const uptime = view.connectedAt
    ? `${Math.floor((Date.now() - view.connectedAt) / 60_000)}m`
    : '\u2014';

  return (
    <Box borderStyle="single" paddingX={1} flexDirection="column">
      <Box>
        <Text color={dotColor}>{'\u25CF'}</Text>
        <Text>
          {' '}
          {view.connectionState} Uptime: {uptime} Tools: {view.tools.length}
        </Text>
        {view.reloading && <Text color="yellow"> {'\u27F3'} reloading</Text>}
      </Box>
      {view.recentErrors.length > 0 && (
        <Text color="red"> Errors: {view.recentErrors.length}</Text>
      )}
    </Box>
  );
}

// ── SetupChecklist ─────────────────────────────────────────────────

function SetupChecklist({ view }: { view: SnapshotView }) {
  if (view.setupSteps.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Setup</Text>
      {view.setupSteps.map(([key, step]) => {
        const icon =
          step.status === 'ok'
            ? '\u2713'
            : step.status === 'error'
              ? '\u2717'
              : '\u2026';
        const color =
          step.status === 'ok'
            ? 'green'
            : step.status === 'error'
              ? 'red'
              : 'yellow';

        return (
          <Text key={key}>
            <Text color={color}> {icon}</Text>
            <Text>
              {' '}
              {key}
              {step.detail ? ': ' + step.detail : ''}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── ToolOverlay (? key toggle) ─────────────────────────────────────

function ToolOverlay({ view }: { view: SnapshotView }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Tools ({view.tools.length})</Text>
      {view.tools.map((t) => (
        <Text key={`${t.server}:${t.name}`}>
          <Text color="cyan"> {t.name}</Text>
          <Text dimColor> ({t.server})</Text>
        </Text>
      ))}
    </Box>
  );
}

// ── RecentCalls ────────────────────────────────────────────────────

function RecentCalls({ view }: { view: SnapshotView }) {
  // Completed from ring buffer
  const completed = view.recentCalls;
  // In-flight from snapshot
  const inFlight: ToolCallEntry[] = view.inFlightCalls.map(([callId, info]) => ({
    callId,
    tool: info.tool,
    server: info.server,
    startedAt: info.startedAt,
  }));

  // Sort chronologically, take last 8
  const all = [...completed, ...inFlight]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-8);

  if (all.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Recent calls</Text>
      {all.map((c) => {
        const ts = new Date(c.startedAt).toLocaleTimeString('en-GB', {
          hour12: false,
        });

        if (!c.endedAt) {
          // In-flight: live elapsed (updated by 500ms interval)
          const elapsed = Math.floor((Date.now() - c.startedAt) / 1000);
          return (
            <Text key={c.callId}>
              <Text dimColor> {ts}</Text>
              <Text> {c.tool}</Text>
              <Text color="yellow"> {'\u25CF'} {elapsed}s...</Text>
            </Text>
          );
        }

        return (
          <Text key={c.callId}>
            <Text dimColor> {ts}</Text>
            <Text> {c.tool}</Text>
            <Text color={c.ok ? 'green' : 'red'}>
              {' '}
              {c.ok ? 'ok' : 'ERR'}
            </Text>
            <Text dimColor> {c.durationMs}ms</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── KeybindingsBar ─────────────────────────────────────────────────

function KeybindingsBar({ reloading }: { reloading: boolean }) {
  return (
    <Box paddingX={1}>
      <Text dimColor>
        q quit {reloading ? '(reloading\u2026)' : 'r reload MCP'} ? tools c
        clear
      </Text>
    </Box>
  );
}
