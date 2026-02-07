#!/usr/bin/env npx tsx
/**
 * SoundCloud Watcher: Cron script for tracking your SoundCloud account
 * and getting notified about new releases from artists you care about.
 *
 * Features:
 *   - Follower change detection (new/lost followers by name)
 *   - Track engagement tracking (who liked, repost counts)
 *   - New release detection from a curated artist list
 *   - Dormant artist throttling (skip inactive artists to save API calls)
 *   - Rate limit backoff (exponential backoff on 429s)
 *   - Single cron entry runs everything
 *
 * Setup:
 *   1. Create config file (see PATHS below) with your SoundCloud API credentials
 *   2. Run: npx tsx soundcloud_cron.ts add <artist_username>
 *   3. Run: npx tsx soundcloud_cron.ts check
 *   4. Add to cron: 0 * /6 * * * npx tsx /path/to/soundcloud_cron.ts cron
 *
 * Config file format (one KEY=VALUE per line):
 *   SOUNDCLOUD_CLIENT_ID=your_client_id
 *   SOUNDCLOUD_CLIENT_SECRET=your_client_secret
 *   SOUNDCLOUD_ACCESS_TOKEN=auto_managed_by_script
 *   MY_USERNAME=your_soundcloud_username
 *
 * Requirements: Node.js 22+ (uses built-in fetch), npx tsx (or ts-node)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// =============================================================================
// CONFIGURATION - edit these to match your setup
// =============================================================================

/** Your SoundCloud username (the URL slug, e.g. soundcloud.com/THIS_PART) */
const MY_USERNAME = "your_username";

/** Where to store config and data files - using OpenClaw standard paths */
const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_FILE = path.join(OPENCLAW_DIR, "secrets", "soundcloud.env");
const ACCOUNT_DATA = path.join(OPENCLAW_DIR, "data", "soundcloud_tracking.json");
const ARTISTS_DATA = path.join(OPENCLAW_DIR, "data", "artists.json");
const BACKOFF_FILE = path.join(OPENCLAW_DIR, "soundcloud_backoff.json");

// --- Notification settings ---
/** Set to true to send notifications via a gateway, false for stdout only */
const NOTIFICATIONS_ENABLED = false;
const GATEWAY_CONFIG = path.join(OPENCLAW_DIR, "gateway.json");
const GATEWAY_SESSION_KEY = "default";
const GATEWAY_PORT_DEFAULT = 8080;
const GATEWAY_ENDPOINT = "/tools/invoke";
const GATEWAY_TOOL_NAME = "sessions_send";

// =============================================================================
// TUNING - adjust these to balance API usage vs responsiveness
// =============================================================================

/** How many of YOUR recent tracks to monitor for likes/reposts */
const MY_TRACKS_LIMIT = 10;

/** How many recent tracks to fetch per artist when checking for new releases */
const ARTIST_TRACKS_LIMIT = 5;

/** How many tracks to fetch when first adding an artist (seeds known tracks) */
const ARTIST_ADD_LIMIT = 50;

/** Artists who haven't uploaded in this many days are considered "dormant" */
const DORMANT_DAYS = 90;

/** Dormant artists are only checked every N days instead of every run */
const DORMANT_CHECK_INTERVAL_DAYS = 7;

/** Max stored track IDs per artist (older ones pruned to save disk/memory) */
const MAX_KNOWN_TRACKS = 50;

/** Max likers to fetch per track */
const MAX_LIKERS_PER_TRACK = 50;

/** Followers pagination page size (SoundCloud max is 200) */
const FOLLOWERS_PAGE_SIZE = 200;

// --- Rate limit backoff ---
const BACKOFF_BASE_SECONDS = 300; // 5 min initial backoff after a 429
const BACKOFF_MAX_SECONDS = 7200; // 2 hour ceiling

// --- Timeouts ---
const API_TIMEOUT_MS = 15_000;
const GATEWAY_TIMEOUT_MS = 60_000;

// =============================================================================
// INTERNALS - you probably don't need to change anything below
// =============================================================================

const API_BASE = "https://api.soundcloud.com";

// -- Types --------------------------------------------------------------------

interface UserInfo {
  username: string;
  display_name: string;
}

interface TrackStats {
  track_id: number;
  title: string;
  plays: number;
  likes: number;
  reposts: number;
  likers: Record<string, UserInfo>;
}

interface ArtistData {
  username: string;
  display_name: string;
  user_id: number;
  permalink_url: string;
  followers: number;
  track_count: number;
  total_plays: number;
  genres: string[];
  last_upload: string | null;
  known_track_ids: number[];
  added_at: string;
  last_updated: string;
  last_checked?: string;
}

interface AccountState {
  my_account: { user_id: number; username: string } | null;
  my_followers: Record<string, UserInfo>;
  follower_count: number;
  track_stats: TrackStats[];
  last_check: string | null;
}

interface ArtistsState {
  artists: Record<string, ArtistData>;
  updated_at: string | null;
}

interface ReleaseNotification {
  artist: string;
  title: string;
  url: string;
  duration: string;
  genre: string | null;
}

// -- Helpers ------------------------------------------------------------------

function utcnow(): string {
  return new Date().toISOString();
}

function daysSince(isoDate: string): number | null {
  const ms = Date.now() - parseTimestamp(isoDate);
  return isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

/**
 * Parse SoundCloud timestamps into Unix ms.
 * SoundCloud returns dates like: "2026/01/22 16:22:27 +0000"
 */
function parseTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN;
  try {
    // "2026/01/22 16:22:27 +0000" → "2026-01-22T16:22:27+00:00"
    let cleaned = ts.replace(/\//g, "-").replace(" ", "T"); // first space only
    cleaned = cleaned.replace(" +0000", "+00:00").replace("Z", "+00:00");
    const d = new Date(cleaned);
    return d.getTime();
  } catch {
    console.log(`Warning: Could not parse timestamp '${ts}'`);
    return NaN;
  }
}

function ensureDir(filepath: string): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filepath: string, fallback: T): T {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
  } catch {
    /* corrupted file, use fallback */
  }
  return fallback;
}

function writeJson(filepath: string, data: unknown): void {
  ensureDir(filepath);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + "\n");
}

function num(val: unknown): number {
  return (typeof val === "number" ? val : 0) || 0;
}

// -- Config -------------------------------------------------------------------

class Config {
  clientId = "";
  clientSecret = "";
  accessToken = "";
  myUsername = MY_USERNAME;

  static load(): Config {
    const cfg = new Config();
    if (!fs.existsSync(CONFIG_FILE)) return cfg;

    for (const line of fs.readFileSync(CONFIG_FILE, "utf-8").split("\n")) {
      if (!line.includes("=") || line.startsWith("#")) continue;
      const [k, ...rest] = line.split("=");
      const key = k.trim();
      const val = rest.join("=").trim();
      if (key === "SOUNDCLOUD_CLIENT_ID") cfg.clientId = val;
      else if (key === "SOUNDCLOUD_CLIENT_SECRET") cfg.clientSecret = val;
      else if (key === "SOUNDCLOUD_ACCESS_TOKEN") cfg.accessToken = val;
      else if (key === "MY_USERNAME") cfg.myUsername = val;
    }
    return cfg;
  }

  saveToken(token: string): void {
    this.accessToken = token;
    ensureDir(CONFIG_FILE);
    const lines = fs.existsSync(CONFIG_FILE)
      ? fs.readFileSync(CONFIG_FILE, "utf-8").split("\n")
      : [];
    let found = false;
    const newLines = lines.map((line) => {
      if (line.startsWith("SOUNDCLOUD_ACCESS_TOKEN=")) {
        found = true;
        return `SOUNDCLOUD_ACCESS_TOKEN=${token}`;
      }
      return line;
    });
    if (!found) newLines.push(`SOUNDCLOUD_ACCESS_TOKEN=${token}`);
    fs.writeFileSync(CONFIG_FILE, newLines.join("\n") + "\n");
  }
}

// -- SoundCloud API client ----------------------------------------------------

class SoundCloudAPI {
  calls = 0;

  constructor(private config: Config) {}

  private checkBackoff(): number | null {
    const data = readJson<{ last_fail?: number; fail_count?: number }>(
      BACKOFF_FILE,
      {}
    );
    if (!data.last_fail) return null;
    const elapsed = Date.now() / 1000 - data.last_fail;
    const backoff = Math.min(
      BACKOFF_BASE_SECONDS * 2 ** (data.fail_count ?? 0),
      BACKOFF_MAX_SECONDS
    );
    return elapsed < backoff ? Math.floor(backoff - elapsed) : null;
  }

  private setBackoff(): void {
    try {
      const data = readJson<{ fail_count?: number }>(BACKOFF_FILE, {});
      writeJson(BACKOFF_FILE, {
        fail_count: (data.fail_count ?? 0) + 1,
        last_fail: Date.now() / 1000,
      });
    } catch {
      /* best effort */
    }
  }

  private clearBackoff(): void {
    if (fs.existsSync(BACKOFF_FILE)) fs.unlinkSync(BACKOFF_FILE);
  }

  async refreshToken(): Promise<boolean> {
    if (!this.config.clientId || !this.config.clientSecret) return false;

    const remaining = this.checkBackoff();
    if (remaining) {
      console.log(`Token refresh in backoff (${remaining}s remaining)`);
      return false;
    }

    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      });
      const resp = await fetch(`${API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (resp.status === 429) {
        this.setBackoff();
        console.log("Token refresh rate limited (429)");
        return false;
      }
      if (!resp.ok) {
        console.log(`Token refresh failed: ${resp.status}`);
        return false;
      }
      const result = (await resp.json()) as { access_token: string };
      this.config.saveToken(result.access_token);
      this.clearBackoff();
      console.log("Token refreshed");
      return true;
    } catch (e) {
      console.log(`Token refresh failed: ${e}`);
      return false;
    }
  }

  /** Make authenticated GET request. Accepts relative (/users/...) or full URLs. */
  async get(
    url: string,
    params?: Record<string, string | number>,
    retry = true
  ): Promise<Record<string, any> | null> {
    this.calls++;

    let fullUrl: string;
    if (url.startsWith("/")) fullUrl = `${API_BASE}${url}`;
    else if (url.startsWith("http")) fullUrl = url;
    else fullUrl = `${API_BASE}/${url}`;

    if (params) {
      const sep = fullUrl.includes("?") ? "&" : "?";
      const query = new URLSearchParams(
        Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)])
        )
      ).toString();
      fullUrl = `${fullUrl}${sep}${query}`;
    }

    const headers: Record<string, string> = {};
    if (this.config.accessToken) {
      headers["Authorization"] = `OAuth ${this.config.accessToken}`;
    }

    try {
      const resp = await fetch(fullUrl, {
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (resp.status === 401 && retry) {
        if (await this.refreshToken()) {
          return this.get(url, params, false);
        }
      }
      if (!resp.ok) {
        console.log(`API error ${resp.status}: ${fullUrl}`);
        return null;
      }
      return (await resp.json()) as Record<string, any>;
    } catch (e) {
      console.log(`API error: ${e}`);
      return null;
    }
  }

  /** Resolve username to user object. */
  resolve(username: string) {
    return this.get("/resolve", {
      url: `https://soundcloud.com/${username}`,
    });
  }

  /** Get user profile by ID (includes followers_count). */
  getUser(userId: number) {
    return this.get(`/users/${userId}`);
  }

  /** Get a user's tracks. Response includes play/like/repost counts per track. */
  async getTracks(userId: number, limit = 20): Promise<Record<string, any>[]> {
    const data = await this.get(`/users/${userId}/tracks`, {
      limit,
      linked_partitioning: 1,
    });
    if (!data) return [];
    const collection = data.collection ?? data;
    return Array.isArray(collection) ? collection : [];
  }

  /** Get users who liked a specific track. */
  async getTrackLikers(
    trackId: number,
    limit = MAX_LIKERS_PER_TRACK
  ): Promise<Record<string, UserInfo>> {
    const data = await this.get(`/tracks/${trackId}/favoriters`, {
      limit,
      linked_partitioning: 1,
    });
    if (!data) return {};

    const likers: Record<string, UserInfo> = {};
    const collection = data.collection ?? data;
    if (Array.isArray(collection)) {
      for (const u of collection) {
        if (u && typeof u === "object" && "id" in u) {
          likers[String(u.id)] = {
            username: u.permalink ?? u.username ?? "unknown",
            display_name: u.full_name ?? u.username ?? "unknown",
          };
        }
      }
    }
    return likers;
  }

  /** Paginate through all followers. Expensive - only call when follower count changes. */
  async getFollowersPaginated(
    userId: number
  ): Promise<Record<string, UserInfo>> {
    const followers: Record<string, UserInfo> = {};
    let nextUrl: string | null = `/users/${userId}/followers`;
    let params: Record<string, string | number> | undefined = {
      limit: FOLLOWERS_PAGE_SIZE,
      linked_partitioning: 1,
    };

    while (nextUrl) {
      const data = await this.get(nextUrl, params);
      if (!data) break;

      for (const f of data.collection ?? []) {
        if (f && typeof f === "object" && "id" in f) {
          followers[String(f.id)] = {
            username: f.permalink ?? f.username ?? "unknown",
            display_name: f.full_name ?? f.username ?? "unknown",
          };
        }
      }

      const nextHref = data.next_href;
      if (nextHref && nextHref !== nextUrl) {
        nextUrl = nextHref; // Full URL with cursor params included
        params = undefined;
      } else {
        break;
      }
    }
    return followers;
  }
}

// -- Account Watcher ----------------------------------------------------------

class AccountWatcher {
  data: AccountState;

  constructor(
    private api: SoundCloudAPI,
    private config: Config
  ) {
    const defaults: AccountState = {
      my_account: null,
      my_followers: {},
      follower_count: 0,
      track_stats: [],
      last_check: null,
    };
    const loaded = readJson<Partial<AccountState>>(ACCOUNT_DATA, {});
    this.data = { ...defaults, ...loaded };
  }

  private save(): void {
    this.data.last_check = utcnow();
    writeJson(ACCOUNT_DATA, this.data);
  }

  /**
   * Run account check. Returns list of human-readable notification strings.
   *
   * API calls on a quiet day: 2 (profile + tracks)
   * API calls on follower change: 2 + ceil(followers/200) + tracks_with_new_likes
   */
  async check(): Promise<string[]> {
    const notifications: string[] = [];

    // Resolve account on first run
    if (!this.data.my_account) {
      const user = await this.api.resolve(this.config.myUsername);
      if (!user) return ["Failed to resolve SoundCloud user"];
      this.data.my_account = {
        user_id: user.id,
        username: user.permalink ?? this.config.myUsername,
      };
    }

    const userId = this.data.my_account.user_id;

    // Fetch profile to check follower count (1 API call)
    const profile = await this.api.getUser(userId);
    if (!profile) {
      console.log("Failed to fetch profile, skipping account check");
      return notifications; // Don't save - preserve previous state
    }

    const currentCount = num(profile.followers_count);
    const storedCount = this.data.follower_count;

    // Only paginate full follower list if the count actually changed
    if (currentCount !== storedCount || !Object.keys(this.data.my_followers).length) {
      console.log(
        `Follower count changed: ${storedCount} -> ${currentCount}, fetching list...`
      );
      const currentFollowers = await this.api.getFollowersPaginated(userId);

      if (!Object.keys(currentFollowers).length && storedCount > 0) {
        console.log("API returned empty followers, skipping comparison");
      } else {
        const stored = this.data.my_followers;

        // Skip diff on first run (everything would show as "new")
        if (Object.keys(stored).length) {
          const newFollowers = Object.entries(currentFollowers)
            .filter(([uid]) => !stored[uid])
            .map(([, f]) => f.display_name);
          const lostFollowers = Object.entries(stored)
            .filter(([uid]) => !currentFollowers[uid])
            .map(([, f]) => f.display_name);

          if (newFollowers.length) {
            let names = newFollowers.slice(0, 3).join(", ");
            if (newFollowers.length > 3) names += ` +${newFollowers.length - 3} more`;
            notifications.push(
              `New follower${newFollowers.length > 1 ? "s" : ""}: **${names}**`
            );
          }
          if (lostFollowers.length) {
            const names = lostFollowers.slice(0, 3).join(", ");
            notifications.push(
              `Lost follower${lostFollowers.length > 1 ? "s" : ""}: ${names}`
            );
          }
        }

        this.data.my_followers = currentFollowers;
        this.data.follower_count = currentCount;
      }
    } else {
      console.log(`Follower count unchanged (${currentCount}), skipping pagination`);
    }

    // Fetch my tracks - play/like/repost counts included in response (1 API call)
    const tracks = await this.api.getTracks(userId, MY_TRACKS_LIMIT);
    if (tracks.length) {
      const prevMap = new Map(this.data.track_stats.map((s) => [s.track_id, s]));
      const newStats: TrackStats[] = [];

      for (const t of tracks) {
        const trackId: number = t.id;
        const title: string = t.title ?? "Unknown";
        const currentLikes = num(t.likes_count) || num(t.favoritings_count);
        const currentReposts = num(t.reposts_count);

        const stats: TrackStats = {
          track_id: trackId,
          title,
          plays: num(t.playback_count),
          likes: currentLikes,
          reposts: currentReposts,
          likers: {},
        };

        const prev = prevMap.get(trackId);
        if (prev) {
          const prevLikes = prev.likes;
          const prevLikers = prev.likers ?? {};

          // Only fetch liker list if like count changed (or never seeded)
          const needsLikerFetch =
            currentLikes !== prevLikes ||
            (currentLikes > 0 && !Object.keys(prevLikers).length);

          if (needsLikerFetch) {
            const currentLikers = await this.api.getTrackLikers(trackId);
            stats.likers = currentLikers;

            const newLikerNames = Object.entries(currentLikers)
              .filter(([uid]) => !prevLikers[uid])
              .map(([, u]) => u.display_name || u.username);
            const unlikerNames = Object.entries(prevLikers)
              .filter(([uid]) => !currentLikers[uid])
              .map(([, u]) => u.display_name || u.username);

            if (newLikerNames.length) {
              let names = newLikerNames.slice(0, 3).join(", ");
              if (newLikerNames.length > 3)
                names += ` +${newLikerNames.length - 3} more`;
              notifications.push(`**${names}** liked '${title}'`);
            }
            if (unlikerNames.length) {
              const names = unlikerNames.slice(0, 3).join(", ");
              notifications.push(`${names} unliked '${title}'`);
            }
          } else {
            // No change - carry forward previous liker data
            stats.likers = prevLikers;
          }

          const newReposts = currentReposts - (prev.reposts ?? 0);
          if (newReposts > 0) {
            notifications.push(
              `'${title}' got ${newReposts} repost${newReposts > 1 ? "s" : ""}!`
            );
          }
        } else {
          // First time seeing this track - seed likers without notifying
          stats.likers = await this.api.getTrackLikers(trackId);
        }

        newStats.push(stats);
      }

      this.data.track_stats = newStats;
    } else {
      console.log("Failed to fetch tracks, keeping previous stats");
    }

    this.save();
    return notifications;
  }
}

// -- Artist Tracker -----------------------------------------------------------

class ArtistTracker {
  data: ArtistsState;

  constructor(private api: SoundCloudAPI) {
    this.data = readJson<ArtistsState>(ARTISTS_DATA, {
      artists: {},
      updated_at: null,
    });
  }

  private save(): void {
    this.data.updated_at = utcnow();
    writeJson(ARTISTS_DATA, this.data);
  }

  private isDormant(artist: ArtistData): boolean {
    const days = daysSince(artist.last_upload ?? "");
    return days !== null && days > DORMANT_DAYS;
  }

  private shouldSkip(artist: ArtistData): boolean {
    if (!this.isDormant(artist)) return false;
    const days = daysSince(artist.last_checked ?? "");
    return days !== null && days < DORMANT_CHECK_INTERVAL_DAYS;
  }

  /**
   * Check all tracked artists for new releases.
   * API calls: 1 per active artist, 1 per dormant artist due for check, 0 for skipped.
   */
  async checkReleases(): Promise<ReleaseNotification[]> {
    const notifications: ReleaseNotification[] = [];
    let checked = 0;
    let skipped = 0;

    for (const [username, artist] of Object.entries(this.data.artists)) {
      if (this.shouldSkip(artist)) {
        skipped++;
        continue;
      }

      checked++;
      if (!artist.user_id) continue;

      const tracks = await this.api.getTracks(artist.user_id, ARTIST_TRACKS_LIMIT);
      const knownIds = new Set(artist.known_track_ids ?? []);

      this.data.artists[username].last_checked = utcnow();

      for (const track of tracks) {
        if (!knownIds.has(track.id)) {
          const durationSec = Math.floor(num(track.duration) / 1000);
          const min = Math.floor(durationSec / 60);
          const sec = durationSec % 60;

          notifications.push({
            artist: artist.display_name ?? username,
            title: track.title ?? "Unknown",
            url: track.permalink_url ?? "",
            duration: `${min}:${String(sec).padStart(2, "0")}`,
            genre: track.genre ?? null,
          });

          if (!this.data.artists[username].known_track_ids) {
            this.data.artists[username].known_track_ids = [];
          }
          this.data.artists[username].known_track_ids.push(track.id);

          if (track.created_at) {
            this.data.artists[username].last_upload = track.created_at;
          }
        }
      }

      // Prune old track IDs to prevent unbounded growth
      const ids = this.data.artists[username].known_track_ids ?? [];
      if (ids.length > MAX_KNOWN_TRACKS) {
        this.data.artists[username].known_track_ids = ids.slice(-MAX_KNOWN_TRACKS);
      }
    }

    const dormantCount = Object.values(this.data.artists).filter((a) =>
      this.isDormant(a)
    ).length;
    console.log(
      `Checked ${checked} artists, skipped ${skipped} dormant, ${dormantCount} total dormant`
    );

    this.save();
    return notifications;
  }

  /** Add an artist to tracking. Seeds known tracks to avoid false notifications. */
  async add(username: string): Promise<string> {
    const user = await this.api.resolve(username);
    if (!user) return `Could not find user: ${username}`;

    const tracks = await this.api.getTracks(user.id, ARTIST_ADD_LIMIT);

    const totalPlays = tracks.reduce(
      (sum, t) => sum + num(t.playback_count),
      0
    );

    const genreCounts: Record<string, number> = {};
    for (const t of tracks) {
      const g = (t.genre ?? "").toLowerCase().trim();
      if (g) genreCounts[g] = (genreCounts[g] ?? 0) + 1;
    }
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g);

    const dates = tracks.map((t) => t.created_at).filter(Boolean) as string[];
    const lastUpload = dates.length ? dates.sort().pop()! : null;

    const followers = num(user.followers_count);

    this.data.artists[username.toLowerCase()] = {
      username: user.permalink ?? username,
      display_name: user.full_name || user.username || username,
      user_id: user.id,
      permalink_url:
        user.permalink_url ?? `https://soundcloud.com/${username}`,
      followers,
      track_count: num(user.track_count),
      total_plays: totalPlays,
      genres: topGenres,
      last_upload: lastUpload,
      known_track_ids: tracks.map((t) => t.id).slice(-MAX_KNOWN_TRACKS),
      added_at: utcnow(),
      last_updated: utcnow(),
    };
    this.save();

    return `Added ${user.full_name || username} (${followers.toLocaleString()} followers, ${tracks.length} tracks)`;
  }

  /** Remove an artist from tracking. */
  remove(username: string): string {
    const key = username.toLowerCase();
    for (const [k, artist] of Object.entries(this.data.artists)) {
      if (k === key || (artist.username ?? "").toLowerCase() === key) {
        const name = artist.display_name ?? k;
        delete this.data.artists[k];
        this.save();
        return `Removed ${name}`;
      }
    }
    return `Artist '${username}' not found`;
  }

  /** Print all tracked artists sorted by follower count. */
  list(): void {
    const artists = Object.values(this.data.artists).sort(
      (a, b) => (b.followers ?? 0) - (a.followers ?? 0)
    );
    console.log(`\n=== Tracked Artists (${artists.length}) ===\n`);
    for (const a of artists) {
      const dormant = this.isDormant(a);
      const status = dormant ? " [DORMANT]" : "";
      console.log(`${a.display_name} (@${a.username})${status}`);
      console.log(
        `  ${(a.followers ?? 0).toLocaleString()} followers | ${a.track_count ?? 0} tracks`
      );
      if (a.last_upload) console.log(`  Last upload: ${a.last_upload.slice(0, 10)}`);
      console.log();
    }
  }
}

// -- Notification Delivery ----------------------------------------------------

/**
 * Send notification via gateway.
 * To use a different system (email, Discord webhook, Pushover, etc.),
 * replace the body of this function with your preferred delivery mechanism.
 */
async function sendNotification(message: string): Promise<boolean> {
  if (!NOTIFICATIONS_ENABLED) return false;

  let token: string;
  let port: number;
  try {
    const cfg = JSON.parse(fs.readFileSync(GATEWAY_CONFIG, "utf-8"));
    token = cfg.gateway.auth.token;
    port = cfg.gateway.port ?? GATEWAY_PORT_DEFAULT;
  } catch (e) {
    console.log(`Gateway config error: ${e}`);
    return false;
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${port}${GATEWAY_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: GATEWAY_TOOL_NAME,
        args: { sessionKey: GATEWAY_SESSION_KEY, message },
      }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch (e) {
    console.log(`Notification failed: ${e}`);
    return false;
  }
}

// -- Commands -----------------------------------------------------------------

async function runFullCheck(
  api: SoundCloudAPI,
  config: Config
): Promise<[string[], ReleaseNotification[]]> {
  const account = new AccountWatcher(api, config);
  const tracker = new ArtistTracker(api);
  return [await account.check(), await tracker.checkReleases()];
}

async function main(): Promise<void> {
  const config = Config.load();

  if (!config.clientId) {
    console.log(`Error: No SOUNDCLOUD_CLIENT_ID found in ${CONFIG_FILE}`);
    console.log(`\nCreate the config file with:`);
    console.log(`  mkdir -p ${path.dirname(CONFIG_FILE)}`);
    console.log(`  cat > ${CONFIG_FILE} << 'EOF'`);
    console.log(`  SOUNDCLOUD_CLIENT_ID=your_id`);
    console.log(`  SOUNDCLOUD_CLIENT_SECRET=your_secret`);
    console.log(`  MY_USERNAME=${MY_USERNAME}`);
    console.log(`  EOF`);
    return;
  }

  const api = new SoundCloudAPI(config);

  if (!config.accessToken) {
    if (!(await api.refreshToken())) {
      console.log("Failed to get access token");
      return;
    }
  }

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.log("SoundCloud Watcher");
    console.log();
    console.log("Commands:");
    console.log("  status          Show current tracking status");
    console.log("  check           Run full check with verbose output");
    console.log("  cron            Silent mode - only sends notifications on updates");
    console.log("  add <user>      Add artist(s) to track");
    console.log("  remove <user>   Remove artist from tracking");
    console.log("  list            List all tracked artists");
    return;
  }

  if (cmd === "status") {
    const account = new AccountWatcher(api, config);
    const tracker = new ArtistTracker(api);

    console.log("=== SoundCloud Watcher Status ===\n");
    console.log(`Config: ${CONFIG_FILE}`);
    console.log(
      config.accessToken
        ? `Token: ...${config.accessToken.slice(-8)}`
        : "Token: None"
    );
    if (account.data.my_account) {
      console.log(`Account: @${account.data.my_account.username}`);
      console.log(
        `Followers: ${account.data.follower_count || Object.keys(account.data.my_followers).length}`
      );
    }
    const total = Object.keys(tracker.data.artists).length;
    const dormant = Object.values(tracker.data.artists).filter(
      (a) => (daysSince(a.last_upload ?? "") ?? 0) > DORMANT_DAYS
    ).length;
    console.log(
      `Tracked artists: ${total} (${total - dormant} active, ${dormant} dormant)`
    );
    console.log(
      `Notifications: ${NOTIFICATIONS_ENABLED ? "gateway" : "stdout only"}`
    );
    console.log(`Last check: ${account.data.last_check ?? "Never"}`);
  } else if (cmd === "check") {
    console.log(`[${utcnow()}] Running full check...\n`);

    const [accountNotifs, releases] = await runFullCheck(api, config);

    console.log("--- Account ---");
    for (const n of accountNotifs) console.log(`  ${n}`);
    if (!accountNotifs.length) console.log("  No updates");

    console.log("\n--- Artist Releases ---");
    for (const r of releases) console.log(`  ${r.artist}: ${r.title}`);
    if (!releases.length) console.log("  No new releases");

    console.log(`\nAPI calls: ${api.calls}`);
  } else if (cmd === "cron") {
    const [accountNotifs, releases] = await runFullCheck(api, config);

    const lines: string[] = [];
    if (accountNotifs.length) {
      lines.push("**Account:**");
      lines.push(...accountNotifs.map((n) => `- ${n}`));
      lines.push("");
    }
    if (releases.length) {
      lines.push("**New Releases:**");
      for (const r of releases) {
        lines.push(`- **${r.artist}** dropped: ${r.title}`);
        lines.push(`  ${r.url}`);
      }
      lines.push("");
    }

    if (lines.length) {
      const message = "SoundCloud updates:\n\n" + lines.join("\n");
      if (NOTIFICATIONS_ENABLED) {
        await sendNotification(message);
      } else {
        console.log(message);
      }
    }

    console.log(`API calls: ${api.calls}`);
  } else if (cmd === "add" && args.length > 1) {
    const tracker = new ArtistTracker(api);
    for (const username of args.slice(1)) {
      console.log(await tracker.add(username));
    }
  } else if (cmd === "remove" && args.length > 1) {
    const tracker = new ArtistTracker(api);
    console.log(tracker.remove(args[1]));
  } else if (cmd === "list") {
    const tracker = new ArtistTracker(api);
    tracker.list();
  } else {
    console.log(`Unknown command: ${cmd}`);
    console.log("Run without arguments for usage info.");
  }
}

main().catch((e) => {
  console.error(`Fatal error: ${e}`);
  process.exit(1);
});