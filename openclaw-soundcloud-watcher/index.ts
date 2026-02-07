import { SoundCloudWatcher } from './soundcloud_watcher';

interface PluginConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  username: string;
  checkIntervalHours: number;
  myTracksLimit: number;
  dormantDays: number;
  sessionKey?: string;
}

export default function register(api: any) {
  const logger = api.getLogger?.() || console;
  let checkInterval: NodeJS.Timeout | null = null;
  let watcher: SoundCloudWatcher | null = null;

  function getWatcher(): SoundCloudWatcher {
    if (!watcher) {
      const config = api.getConfig() as PluginConfig;
      watcher = new SoundCloudWatcher({
        clientId: config.clientId || '',
        clientSecret: config.clientSecret || '',
        username: config.username || '',
        myTracksLimit: config.myTracksLimit,
        dormantDays: config.dormantDays,
        logger: (...args: any[]) => logger.debug(...args),
      });
    }
    return watcher;
  }

  async function checkForUpdates(config: PluginConfig, sessionKey?: string) {
    if (!config.enabled) {
      logger.debug('SoundCloud watcher is disabled');
      return;
    }

    try {
      logger.info('Running SoundCloud check...');
      const message = await getWatcher().runCron();

      if (message) {
        logger.info('SoundCloud updates found');

        if (sessionKey) {
          try {
            await api.tools.sessions_send({
              sessionKey,
              message,
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

  function startChecking(config: PluginConfig, sessionKey?: string) {
    if (checkInterval) {
      clearInterval(checkInterval);
    }

    const intervalMs = config.checkIntervalHours * 60 * 60 * 1000;

    checkForUpdates(config, sessionKey).catch((err) => {
      logger.error('Initial SoundCloud check failed:', err);
    });

    checkInterval = setInterval(() => {
      checkForUpdates(config, sessionKey).catch((err) => {
        logger.error('Periodic SoundCloud check failed:', err);
      });
    }, intervalMs);

    logger.info(`SoundCloud watcher started (checking every ${config.checkIntervalHours}h)`);
  }

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
      const config = api.getConfig() as PluginConfig;

      let message = '# SoundCloud Watcher Setup\n\n';

      if (config.clientId && config.clientSecret && config.username) {
        message += 'Already configured!\n\n';
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
        message += '4. Verify in chat: `/soundcloud-setup`\n';
      }

      return { text: message };
    },
  });

  api.registerCommand({
    name: 'soundcloud-status',
    description: 'Show SoundCloud watcher status',
    handler: async (ctx: any) => {
      const result = await getWatcher().status();
      return { text: result };
    },
  });

  api.registerCommand({
    name: 'soundcloud-check',
    description: 'Run an immediate SoundCloud check',
    handler: async (ctx: any) => {
      const result = await getWatcher().check();
      return { text: result };
    },
  });

  api.registerCommand({
    name: 'soundcloud-add',
    description: 'Add artist(s) to track',
    handler: async (ctx: any, ...usernames: string[]) => {
      if (usernames.length === 0) {
        return { text: 'Usage: /soundcloud-add <username> [username2] ...' };
      }
      const result = await getWatcher().addArtists(usernames);
      return { text: result };
    },
  });

  api.registerCommand({
    name: 'soundcloud-remove',
    description: 'Remove an artist from tracking',
    handler: async (ctx: any, username?: string) => {
      if (!username) {
        return { text: 'Usage: /soundcloud-remove <username>' };
      }
      const result = await getWatcher().removeArtist(username);
      return { text: result };
    },
  });

  api.registerCommand({
    name: 'soundcloud-list',
    description: 'List all tracked artists',
    handler: async (ctx: any) => {
      const result = await getWatcher().listArtists();
      return { text: result };
    },
  });

  // Handle config changes
  api.onConfigChange?.((config: PluginConfig) => {
    watcher = null; // Reset watcher so it picks up new config
    if (config.enabled) {
      const sessionKey = config.sessionKey || 'agent:main:main';
      startChecking(config, sessionKey);
    } else {
      stopChecking();
    }
  });

  // Initialize on load
  const initialConfig = api.getConfig() as PluginConfig;
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
