/**
 * Heartbeat Command
 *
 * Manual heartbeat management: list tasks, view status, trigger execution.
 *
 * Usage:
 *   kyberbot heartbeat list     # Show tasks from HEARTBEAT.md
 *   kyberbot heartbeat status   # Show config and execution state
 *   kyberbot heartbeat run      # Trigger immediate heartbeat tick
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getHeartbeatInterval, getIdentity, getTimezone, paths } from '../config.js';
import { getClaudeClient } from '../claude.js';

interface ParsedTask {
  name: string;
  cadence: string;
  window: string | null;
  action: string;
}

function parseHeartbeatTasks(content: string): ParsedTask[] {
  const tasksIdx = content.indexOf('## Tasks');
  if (tasksIdx === -1) return [];

  const tasksSection = content.slice(tasksIdx);
  const taskBlocks = tasksSection.split(/^### /m).slice(1); // Skip the "## Tasks" header

  return taskBlocks.map((block) => {
    const lines = block.trim().split('\n');
    const name = lines[0].trim();

    let cadence = '';
    let window: string | null = null;
    let action = '';

    for (const line of lines) {
      const cadenceMatch = line.match(/\*\*(?:Cadence|Schedule)\*\*:\s*(.+)/);
      if (cadenceMatch) cadence = cadenceMatch[1].trim();

      const windowMatch = line.match(/\*\*Window\*\*:\s*(.+)/);
      if (windowMatch) window = windowMatch[1].trim();

      const actionMatch = line.match(/\*\*Action\*\*:\s*(.+)/);
      if (actionMatch) action = actionMatch[1].trim();
    }

    return { name, cadence, window, action };
  });
}

export function createHeartbeatCommand(): Command {
  const cmd = new Command('heartbeat')
    .description('Manage heartbeat tasks and scheduling');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot heartbeat list
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('Show tasks defined in HEARTBEAT.md')
    .action(() => {
      const heartbeatPath = paths.heartbeat;

      if (!existsSync(heartbeatPath)) {
        console.log(chalk.yellow('\nNo HEARTBEAT.md found.'));
        console.log(chalk.dim('  Add tasks to HEARTBEAT.md or ask your agent to create them.\n'));
        return;
      }

      const content = readFileSync(heartbeatPath, 'utf-8');
      const tasks = parseHeartbeatTasks(content);

      console.log(chalk.cyan.bold('\nHeartbeat Tasks\n'));

      if (tasks.length === 0) {
        console.log(chalk.dim('  No tasks defined yet.'));
        console.log(chalk.dim('  Add tasks under ## Tasks in HEARTBEAT.md.\n'));
        return;
      }

      for (const task of tasks) {
        console.log(`  ${chalk.white.bold(task.name)}`);
        console.log(chalk.dim(`    Cadence: ${task.cadence || 'not set'}`));
        if (task.window) {
          console.log(chalk.dim(`    Window:  ${task.window}`));
        }
        if (task.action) {
          console.log(chalk.dim(`    Action:  ${task.action.slice(0, 80)}${task.action.length > 80 ? '...' : ''}`));
        }
        console.log('');
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot heartbeat status
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('status')
    .description('Show heartbeat configuration and execution state')
    .action(() => {
      console.log(chalk.cyan.bold('\nHeartbeat Status\n'));

      // Config
      try {
        const intervalMs = getHeartbeatInterval();
        const intervalMin = intervalMs / 1000 / 60;
        console.log(`  Interval:  ${chalk.white(`${intervalMin} minutes`)}`);
      } catch {
        console.log(`  Interval:  ${chalk.yellow('not configured (default 30m)')}`);
      }

      try {
        const identity = getIdentity();
        const activeHours = identity.heartbeat_active_hours;
        if (activeHours) {
          const tz = activeHours.timezone || getTimezone();
          console.log(`  Active:    ${chalk.white(`${activeHours.start} - ${activeHours.end} (${tz})`)}`);
        } else {
          console.log(`  Active:    ${chalk.dim('always (no restriction)')}`);
        }
      } catch {
        console.log(`  Active:    ${chalk.dim('unknown')}`);
      }

      console.log(`  Timezone:  ${chalk.white(getTimezone())}`);
      console.log('');

      // Tasks + state
      const heartbeatPath = paths.heartbeat;
      if (!existsSync(heartbeatPath)) {
        console.log(chalk.yellow('  No HEARTBEAT.md found.\n'));
        return;
      }

      const content = readFileSync(heartbeatPath, 'utf-8');
      const tasks = parseHeartbeatTasks(content);

      const statePath = paths.heartbeatState;
      const state = existsSync(statePath)
        ? JSON.parse(readFileSync(statePath, 'utf-8'))
        : { lastChecks: {} };

      if (tasks.length === 0) {
        console.log(chalk.dim('  No tasks defined.\n'));
        return;
      }

      console.log(chalk.dim('  Tasks:\n'));

      for (const task of tasks) {
        const lastRun = state.lastChecks?.[task.name];
        let lastRunStr: string;
        let agoStr = '';

        if (lastRun) {
          const lastRunDate = new Date(lastRun);
          const agoMs = Date.now() - lastRunDate.getTime();
          const agoMin = Math.round(agoMs / 60000);

          if (agoMin < 60) {
            agoStr = `${agoMin}m ago`;
          } else if (agoMin < 1440) {
            agoStr = `${(agoMin / 60).toFixed(1)}h ago`;
          } else {
            agoStr = `${Math.round(agoMin / 1440)}d ago`;
          }

          lastRunStr = chalk.white(`${lastRun} (${agoStr})`);
        } else {
          lastRunStr = chalk.yellow('never');
        }

        console.log(`  ${chalk.white.bold(task.name)}`);
        console.log(chalk.dim(`    Cadence:  ${task.cadence || 'not set'}`));
        console.log(`    Last run: ${lastRunStr}`);
        console.log('');
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot heartbeat run
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('run')
    .description('Trigger an immediate heartbeat tick')
    .action(async () => {
      const heartbeatPath = paths.heartbeat;

      if (!existsSync(heartbeatPath)) {
        console.error(chalk.red('\nNo HEARTBEAT.md found.'));
        console.log(chalk.dim('  Add tasks to HEARTBEAT.md first.\n'));
        process.exit(1);
      }

      const content = readFileSync(heartbeatPath, 'utf-8').trim();
      if (!content || !content.includes('## Tasks')) {
        console.error(chalk.red('\nHEARTBEAT.md has no tasks section.'));
        process.exit(1);
      }

      const stateFile = paths.heartbeatState;
      const state = existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf-8'))
        : { lastChecks: {} };

      console.log(chalk.cyan('Running heartbeat...\n'));

      const prompt = [
        'Read HEARTBEAT.md. Follow it strictly.',
        'Check heartbeat-state.json to determine which task is most overdue.',
        'Run only that task. Update heartbeat-state.json when done.',
        'If nothing needs attention, reply HEARTBEAT_OK.',
        '',
        '--- HEARTBEAT.md ---',
        content,
        '',
        '--- heartbeat-state.json ---',
        JSON.stringify(state, null, 2),
        '',
        `Current time: ${new Date().toISOString()}`,
        `Timezone: ${getTimezone()}`,
      ].join('\n');

      try {
        const client = getClaudeClient();
        const result = await client.complete(prompt, {
          system: 'You are a heartbeat scheduler. Execute the most overdue task from HEARTBEAT.md. Return HEARTBEAT_OK if nothing needs attention.',
        });

        if (result.trim() === 'HEARTBEAT_OK') {
          console.log(chalk.green('Nothing actionable — all tasks are up to date.\n'));
        } else {
          console.log(chalk.green('Heartbeat result:\n'));
          console.log(result);
          console.log('');

          // Log to heartbeat log
          const logDir = dirname(paths.heartbeatLog);
          mkdirSync(logDir, { recursive: true });
          appendFileSync(
            paths.heartbeatLog,
            `\n--- ${new Date().toISOString()} (manual) ---\n${result}\n`,
            'utf-8'
          );
        }
      } catch (error) {
        console.error(chalk.red(`Heartbeat failed: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}
