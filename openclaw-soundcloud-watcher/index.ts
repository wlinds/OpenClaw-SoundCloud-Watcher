import { spawn } from 'child_process';
import { join } from 'path';

interface SoundCloudConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  username: string;
  checkIntervalHours: number;
  myTracksLimit: number;
  dormantDays: number;
  sessionKey?: string;  // Where to send notifications (defaults to 'agent:main:main')
}

export default function register(api: any) {
  const logger = api.getLogger?.() || console;
  let checkInterval: NodeJS.Timeout | null = null;

  // Path to the TypeScript watcher script
  const scriptPath = join(__dirname, 'soundcloud_watcher.ts');

  /**
   * Execute the TypeScript watcher script with given arguments
   */
  async function runWatcherScript(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      // Use tsx to run the file directly
      const proc = spawn('npx', ['tsx', scriptPath, ...args], {
        cwd: __dirname,
        env: {
          ...process.env,
          // Pass config via environment vars
          SOUNDCLOUD_CLIENT_ID: api.getConfig?.()?.clientId || '',
          SOUNDCLOUD_CLIENT_SECRET: api.getConfig?.()?.clientSecret || '',
          MY_USERNAME: api.getConfig?.()?.username || '',
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, code: code || 0 });
      });

      proc.on('error', (err) => {
        resolve({ stdout, stderr: err.message, code: 1 });
      });
    });
  }

  /**
   * Run a check for SoundCloud updates
   */
  async function checkForUpdates(config: SoundCloudConfig, sessionKey?: string) {
    if (!config.enabled) {
      logger.debug('SoundCloud watcher is disabled');
      return;
    }

    try {
      logger.info('Running SoundCloud check...');
      const result = await runWatcherScript(['cron']);

      if (result.code !== 0) {
        logger.error('SoundCloud check failed:', result.stderr || result.stdout);
        return;
      }

      // The script outputs notifications to stdout in cron mode
      if (result.stdout.trim()) {
        logger.info('SoundCloud updates found:', result.stdout);

        // If a session key is provided, send the notification there
        if (sessionKey) {
          try {
            await api.tools.sessions_send({
              sessionKey,
              message: result.stdout.trim(),
            });
          } catch (err) {
            logger.error('Failed to send notification:', err);
          }
        }
      } else {
        logger.debug('No SoundCloud updates');
      }
    } catch (err) {
      logger.error('Error during SoundCloud check:', err);
    }
  }

  /**
   * Start the periodic check loop
   */
  function startChecking(config: SoundCloudConfig, sessionKey?: string) {
    if (checkInterval) {
      clearInterval(checkInterval);
    }

    const intervalMs = config.checkIntervalHours * 60 * 60 * 1000;

    // Run immediately on startup
    checkForUpdates(config, sessionKey).catch((err) => {
      logger.error('Initial SoundCloud check failed:', err);
    });

    // Then run periodically
    checkInterval = setInterval(() => {
      checkForUpdates(config, sessionKey).catch((err) => {
        logger.error('Periodic SoundCloud check failed:', err);
      });
    }, intervalMs);

    logger.info(`SoundCloud watcher started (checking every ${config.checkIntervalHours}h)`);
  }

  /**
   * Stop the periodic check loop
   */
  function stopChecking() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      logger.info('SoundCloud watcher stopped');
    }
  }

  // Register commands
  api.registerCommand({
    name: 'soundcloud-setup',
    description: 'Interactive setup for SoundCloud credentials',
    handler: async (ctx: any) => {
      const config = api.getConfig() as SoundCloudConfig;

      let message = '# SoundCloud Watcher Setup\n\n';

      if (config.clientId && config.clientSecret && config.username) {
        message += '✓ Already configured!\n\n';
        message += `- Username: ${config.username}\n`;
        message += `- Client ID: ${config.clientId.substring(0, 8)}...${config.clientId.slice(-4)}\n`;
        message += `- Check interval: ${config.checkIntervalHours} hours\n`;
        message += `- Session key: ${config.sessionKey || 'agent:main:main'}\n\n`;
        message += 'To update, edit `~/.openclaw/openclaw.json` under:\n';
        message += '`plugins.entries.soundcloud-watcher.config`\n\n';
        message += 'Then restart: `openclaw gateway restart`';
      } else {
        message += 'Warning: Not configured yet\n\n';
        message += '## Steps:\n\n';
        message += '1. Get credentials from https://soundcloud.com/you/apps\n';
        message += '2. Edit `~/.openclaw/openclaw.json`:\n\n';
        message += '```json\n';
        message += '{\n';
        message += '  "plugins": {\n';
        message += '    "entries": {\n';
        message += '      "soundcloud-watcher": {\n';
        message += '        "enabled": true,\n';
        message += '        "config": {\n';
        message += '          "clientId": "YOUR_CLIENT_ID",\n';
        message += '          "clientSecret": "YOUR_CLIENT_SECRET",\n';
        message += '          "username": "your_soundcloud_username",\n';
        message += '          "checkIntervalHours": 6\n';
        message += '        }\n';
        message += '      }\n';
        message += '    }\n';
        message += '  }\n';
        message += '}\n';
        message += '```\n\n';
        message += '3. Restart: `openclaw gateway restart`\n';
        message += '4. Run: `/soundcloud-status` to verify';
      }

      return { text: message };
    },
  });

  api.registerCommand({
    name: 'soundcloud-status',
    description: 'Show SoundCloud watcher status',
    handler: async (ctx: any) => {
      const result = await runWatcherScript(['status']);
      return { text: result.stdout || result.stderr };
    },
  });

  api.registerCommand({
    name: 'soundcloud-check',
    description: 'Run an immediate SoundCloud check',
    handler: async (ctx: any) => {
      const result = await runWatcherScript(['check']);
      return { text: result.stdout || result.stderr };
    },
  });

  api.registerCommand({
    name: 'soundcloud-add',
    description: 'Add artist(s) to track',
    handler: async (ctx: any, ...usernames: string[]) => {
      if (usernames.length === 0) {
        return { text: 'Usage: /soundcloud-add <username> [username2] ...' };
      }
      const result = await runWatcherScript(['add', ...usernames]);
      return { text: result.stdout || result.stderr };
    },
  });

  api.registerCommand({
    name: 'soundcloud-remove',
    description: 'Remove an artist from tracking',
    handler: async (ctx: any, username?: string) => {
      if (!username) {
        return { text: 'Usage: /soundcloud-remove <username>' };
      }
      const result = await runWatcherScript(['remove', username]);
      return { text: result.stdout || result.stderr };
    },
  });

  api.registerCommand({
    name: 'soundcloud-list',
    description: 'List all tracked artists',
    handler: async (ctx: any) => {
      const result = await runWatcherScript(['list']);
      return { text: result.stdout || result.stderr };
    },
  });

  // Handle config changes
  api.onConfigChange?.((config: SoundCloudConfig) => {
    if (config.enabled) {
      const sessionKey = config.sessionKey || 'agent:main:main';
      startChecking(config, sessionKey);
    } else {
      stopChecking();
    }
  });

  // Initialize on load
  const initialConfig = api.getConfig() as SoundCloudConfig;
  if (initialConfig.enabled) {
    const sessionKey = initialConfig.sessionKey || 'agent:main:main';
    startChecking(initialConfig, sessionKey);
  }

  // Cleanup on unload
  api.onUnload?.(() => {
    stopChecking();
  });

  logger.info('SoundCloud Watcher plugin loaded');
}
