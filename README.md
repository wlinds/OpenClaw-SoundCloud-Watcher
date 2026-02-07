# SoundCloud Watcher - OpenClaw Plugin

Monitor your SoundCloud account and track artist releases. Get notified when someone follows you, likes your tracks, or when artists you care about drop new music.


## Features

- **Follower tracking** - See who followed you recently
- **Track engagement** - Monitor who liked your tracks
- **New releases** - Get notifications when tracked artists release new music
- **Smart API usage** - Only fetches what changed, automatically skips dormant artists (configurable threshold)
- **Rate limit handling** - Exponential backoff for API reliability
- **Automatic background checking** - Configurable interval (default: 6 hours)
- **Session-agnostic notifications** - Works with any OpenClaw session (Telegram, Discord, etc.)

## Prerequisites

- OpenClaw gateway running
- Node.js 22+ installed
- SoundCloud API credentials ([get them here](https://soundcloud.com/you/apps))

## Quick Start

### 1. Install

```bash
# From npm (recommended)
openclaw plugins install @akilles/soundcloud-watcher

# Or from source
git clone https://github.com/wlinds/openclaw-soundcloud-watcher
openclaw plugins install -l ./openclaw-soundcloud-watcher/openclaw-soundcloud-watcher
```


### 2. Get SoundCloud Credentials

1. Log into SoundCloud
2. Go to [soundcloud.com/you/apps](https://soundcloud.com/you/apps)
3. Click "Register a new application"
4. Fill in name and website
5. Copy your **Client ID** and **Client Secret** for next step

### 3. Configure

Run the setup command to see the configuration template:

```bash
/soundcloud-setup
```

Then edit `~/.openclaw/openclaw.json` and paste your credentials:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "soundcloud-watcher": {
        "enabled": true,
        "config": {
          "clientId": "YOUR_CLIENT_ID",
          "clientSecret": "YOUR_CLIENT_SECRET",
          "username": "your_soundcloud_username",
          "checkIntervalHours": 6,
          "myTracksLimit": 10,
          "dormantDays": 90,
          "sessionKey": "agent:main:main"
        }
      }
    }
  }
}
```

### 4. Restart & Verify

```bash
openclaw gateway restart
openclaw plugins list        # Should show soundcloud-watcher
/soundcloud-status           # Should show your account info
```

### 5. Start Tracking your favorite artist

```bash
/soundcloud-add lindstedt
/soundcloud-add noisia
/soundcloud-list
```

Done! Updates arrive automatically every 6 hours.

## Commands

| Command | Description |
|---------|-------------|
| `/soundcloud-setup` | Interactive setup guide with config status |
| `/soundcloud-status` | Show tracking status and account info |
| `/soundcloud-check` | Run immediate check (don't wait for interval) |
| `/soundcloud-add <username>` | Track artist(s) - space-separated |
| `/soundcloud-remove <username>` | Untrack artist |
| `/soundcloud-list` | List all tracked artists |

## Configuration Options

All options in `~/.openclaw/openclaw.json` under `plugins.entries.soundcloud-watcher.config`:

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `enabled` | boolean | No | true | Enable/disable watcher |
| `clientId` | string | Yes | - | SoundCloud API Client ID |
| `clientSecret` | string | Yes | - | SoundCloud API Client Secret |
| `username` | string | Yes | - | Your SoundCloud username |
| `checkIntervalHours` | number | No | 6 | Hours between automatic checks |
| `myTracksLimit` | number | No | 10 | Number of your tracks to monitor |
| `dormantDays` | number | No | 90 | Days before artist is considered dormant |
| `sessionKey` | string | No | `agent:main:main` | OpenClaw session for notifications |

## Architecture

The plugin consists of three main components:

- **Plugin entry** ([openclaw-soundcloud-watcher/index.ts](openclaw-soundcloud-watcher/index.ts)) - Manages lifecycle, spawns watcher process
- **Watcher** ([openclaw-soundcloud-watcher/soundcloud_watcher.ts](openclaw-soundcloud-watcher/soundcloud_watcher.ts)) - Pure TypeScript implementation of monitoring logic
- **Manifest** ([openclaw-soundcloud-watcher/openclaw.plugin.json](openclaw-soundcloud-watcher/openclaw.plugin.json)) - Configuration schema and plugin metadata

### File Locations

After installation:

- **Plugin code:** `~/.openclaw/extensions/soundcloud-watcher/`
- **Config:** `~/.openclaw/openclaw.json`
- **Credentials:** `~/.openclaw/secrets/soundcloud.env`
- **Account data:** `~/.openclaw/data/soundcloud_tracking.json`
- **Artist data:** `~/.openclaw/data/artists.json`
- **Backoff state:** `~/.openclaw/soundcloud_backoff.json`

## Troubleshooting

### Plugin not loading

```bash
openclaw plugins list
openclaw gateway logs
```

Check that:
- Plugin shows as `enabled: true` in list
- Gateway logs don't show errors

Verify plugin directory exists:
```bash
ls -la ~/.openclaw/extensions/soundcloud-watcher/
```

### API rate limits

If you hit rate limits:
1. Increase `checkIntervalHours` in config (default: 6)
2. Increase `dormantDays` to skip inactive artists sooner (default: 90)
3. Check SoundCloud API status

### No notifications

Check gateway session key in the plugin config (default is `agent:main:main`).

Verify gateway is running:
```bash
openclaw gateway status
```

### Setup help

Run `/soundcloud-setup` for detailed instructions with current config status.

## Updating

If installed via symlink (`-l`):
```bash
cd /path/to/openclaw-soundcloud-watcher
git pull
openclaw gateway restart
```

If installed from npm:
```bash
openclaw plugins install @akilles/soundcloud-watcher  # Gets latest
openclaw gateway restart
```

## Uninstalling

```bash
openclaw plugins disable soundcloud-watcher
openclaw plugins uninstall soundcloud-watcher
```

Clean up data (optional):
```bash
rm -rf ~/.openclaw/data/soundcloud_tracking.json
rm -rf ~/.openclaw/data/artists.json
rm -rf ~/.openclaw/secrets/soundcloud.env
rm -rf ~/.openclaw/soundcloud_backoff.json
```

## Support

- **GitHub:** https://github.com/wlinds/openclaw-soundcloud-watcher
- **Issues:** https://github.com/wlinds/openclaw-soundcloud-watcher/issues
- **OpenClaw Docs:** https://docs.openclaw.ai/plugin

## License

MIT - See [LICENSE](LICENSE) for details