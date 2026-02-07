/**
 * SoundCloud Watcher: Module for tracking your SoundCloud account
 * and getting notified about new releases from artists you care about.
 *
 * Features:
 *   - Follower change detection (new/lost followers by name)
 *   - Track engagement tracking (who liked, repost counts)
 *   - New release detection from a curated artist list
 *   - Dormant artist throttling (skip inactive artists to save API calls)
 *   - Rate limit backoff (exponential backoff on 429s)
 *
 * Exported as a class for direct import (no subprocess spawning).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// =============================================================================
// CONFIGURATION
// =============================================================================

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_FILE = path.join(OPENCLAW_DIR, "secrets", "soundcloud.env");
const ACCOUNT_DATA = path.join(OPENCLAW_DIR, "data", "soundcloud_tracking.json");
const ARTISTS_DATA = path.join(OPENCLAW_DIR, "data", "artists.json");
const BACKOFF_FILE = path.join(OPENCLAW_DIR, "soundcloud_backoff.json");

// =============================================================================
// TUNING
// =============================================================================

const ARTIST_TRACKS_LIMIT = 5;
const ARTIST_ADD_LIMIT = 50;
const DORMANT_CHECK_INTERVAL_DAYS = 7;
const MAX_KNOWN_TRACKS = 50;
const MAX_LIKERS_PER_TRACK = 50;
const FOLLOWERS_PAGE_SIZE = 200;

const BACKOFF_BASE_SECONDS = 300;
const BACKOFF_MAX_SECONDS = 7200;

const API_TIMEOUT_MS = 15_000;

// =============================================================================
// INTERNALS
// =============================================================================

const API_BASE = "https://api.soundcloud.com";

// -- Types --------------------------------------------------------------------

export interface SoundCloudWatcherConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  myTracksLimit?: number;
  dormantDays?: number;
  logger?: (...args: any[]) => void;
}

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

function parseTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN;
  try {
    let cleaned = ts.replace(/\//g, "-").replace(" ", "T");
    cleaned = cleaned.replace(" +0000", "+00:00").replace("Z", "+00:00");
    const d = new Date(cleaned);
    return d.getTime();
  } catch {
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
  clientId: string;
  clientSecret: string;
  accessToken = "";
  myUsername: string;

  constructor(clientId: string, clientSecret: string, username: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.myUsername = username;

    // Load persisted access token from env file if it exists
    if (fs.existsSync(CONFIG_FILE)) {
      for (const line of fs.readFileSync(CONFIG_FILE, "utf-8").split("\n")) {
        if (!line.includes("=") || line.startsWith("#")) continue;
        const [k, ...rest] = line.split("=");
        if (k.trim() === "SOUNDCLOUD_ACCESS_TOKEN") {
          this.accessToken = rest.join("=").trim();
        }
      }
    }
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

  constructor(
    private config: Config,
    private log: (...args: any[]) => void
  ) {}

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
      this.log(`Token refresh in backoff (${remaining}s remaining)`);
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
        this.log("Token refresh rate limited (429)");
        return false;
      }
      if (!resp.ok) {
        this.log(`Token refresh failed: ${resp.status}`);
        return false;
      }
      const result = (await resp.json()) as { access_token: string };
      this.config.saveToken(result.access_token);
      this.clearBackoff();
      this.log("Token refreshed");
      return true;
    } catch (e) {
      this.log(`Token refresh failed: ${e}`);
      return false;
    }
  }

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
        this.log(`API error ${resp.status}: ${fullUrl}`);
        return null;
      }
      return (await resp.json()) as Record<string, any>;
    } catch (e) {
      this.log(`API error: ${e}`);
      return null;
    }
  }

  resolve(username: string) {
    return this.get("/resolve", {
      url: `https://soundcloud.com/${username}`,
    });
  }

  getUser(userId: number) {
    return this.get(`/users/${userId}`);
  }

  async getTracks(userId: number, limit = 20): Promise<Record<string, any>[]> {
    const data = await this.get(`/users/${userId}/tracks`, {
      limit,
      linked_partitioning: 1,
    });
    if (!data) return [];
    const collection = data.collection ?? data;
    return Array.isArray(collection) ? collection : [];
  }

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
        nextUrl = nextHref;
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
    private config: Config,
    private myTracksLimit: number,
    private log: (...args: any[]) => void
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

  async check(): Promise<string[]> {
    const notifications: string[] = [];

    if (!this.data.my_account) {
      const user = await this.api.resolve(this.config.myUsername);
      if (!user) return ["Failed to resolve SoundCloud user"];
      this.data.my_account = {
        user_id: user.id,
        username: user.permalink ?? this.config.myUsername,
      };
    }

    const userId = this.data.my_account.user_id;

    const profile = await this.api.getUser(userId);
    if (!profile) {
      this.log("Failed to fetch profile, skipping account check");
      return notifications;
    }

    const currentCount = num(profile.followers_count);
    const storedCount = this.data.follower_count;

    if (currentCount !== storedCount || !Object.keys(this.data.my_followers).length) {
      this.log(
        `Follower count changed: ${storedCount} -> ${currentCount}, fetching list...`
      );
      const currentFollowers = await this.api.getFollowersPaginated(userId);

      if (!Object.keys(currentFollowers).length && storedCount > 0) {
        this.log("API returned empty followers, skipping comparison");
      } else {
        const stored = this.data.my_followers;

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
      this.log(`Follower count unchanged (${currentCount}), skipping pagination`);
    }

    const tracks = await this.api.getTracks(userId, this.myTracksLimit);
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
            stats.likers = prevLikers;
          }

          const newReposts = currentReposts - (prev.reposts ?? 0);
          if (newReposts > 0) {
            notifications.push(
              `'${title}' got ${newReposts} repost${newReposts > 1 ? "s" : ""}!`
            );
          }
        } else {
          stats.likers = await this.api.getTrackLikers(trackId);
        }

        newStats.push(stats);
      }

      this.data.track_stats = newStats;
    } else {
      this.log("Failed to fetch tracks, keeping previous stats");
    }

    this.save();
    return notifications;
  }
}

// -- Artist Tracker -----------------------------------------------------------

class ArtistTracker {
  data: ArtistsState;

  constructor(
    private api: SoundCloudAPI,
    private dormantDays: number,
    private log: (...args: any[]) => void
  ) {
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
    return days !== null && days > this.dormantDays;
  }

  private shouldSkip(artist: ArtistData): boolean {
    if (!this.isDormant(artist)) return false;
    const days = daysSince(artist.last_checked ?? "");
    return days !== null && days < DORMANT_CHECK_INTERVAL_DAYS;
  }

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

      const ids = this.data.artists[username].known_track_ids ?? [];
      if (ids.length > MAX_KNOWN_TRACKS) {
        this.data.artists[username].known_track_ids = ids.slice(-MAX_KNOWN_TRACKS);
      }
    }

    const dormantCount = Object.values(this.data.artists).filter((a) =>
      this.isDormant(a)
    ).length;
    this.log(
      `Checked ${checked} artists, skipped ${skipped} dormant, ${dormantCount} total dormant`
    );

    this.save();
    return notifications;
  }

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

  list(): string {
    const artists = Object.values(this.data.artists).sort(
      (a, b) => (b.followers ?? 0) - (a.followers ?? 0)
    );
    const lines: string[] = [];
    lines.push(`\n=== Tracked Artists (${artists.length}) ===\n`);
    for (const a of artists) {
      const dormant = this.isDormant(a);
      const status = dormant ? " [DORMANT]" : "";
      lines.push(`${a.display_name} (@${a.username})${status}`);
      lines.push(
        `  ${(a.followers ?? 0).toLocaleString()} followers | ${a.track_count ?? 0} tracks`
      );
      if (a.last_upload) lines.push(`  Last upload: ${a.last_upload.slice(0, 10)}`);
      lines.push("");
    }
    return lines.join("\n");
  }
}

// =============================================================================
// EXPORTED FACADE
// =============================================================================

export class SoundCloudWatcher {
  private config: Config;
  private api: SoundCloudAPI;
  private myTracksLimit: number;
  private dormantDays: number;
  private log: (...args: any[]) => void;

  constructor(opts: SoundCloudWatcherConfig) {
    this.log = opts.logger ?? console.log;
    this.myTracksLimit = opts.myTracksLimit ?? 10;
    this.dormantDays = opts.dormantDays ?? 90;
    this.config = new Config(opts.clientId, opts.clientSecret, opts.username);
    this.api = new SoundCloudAPI(this.config, this.log);
  }

  private async ensureToken(): Promise<string | null> {
    if (this.config.accessToken) return null;
    if (!(await this.api.refreshToken())) {
      return "Failed to get access token. Check your clientId and clientSecret.";
    }
    return null;
  }

  async status(): Promise<string> {
    const account = new AccountWatcher(this.api, this.config, this.myTracksLimit, this.log);
    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);

    const lines: string[] = [];
    lines.push("=== SoundCloud Watcher Status ===\n");
    lines.push(`Config: ${CONFIG_FILE}`);
    lines.push(
      this.config.accessToken
        ? `Token: ...${this.config.accessToken.slice(-8)}`
        : "Token: None"
    );
    if (account.data.my_account) {
      lines.push(`Account: @${account.data.my_account.username}`);
      lines.push(
        `Followers: ${account.data.follower_count || Object.keys(account.data.my_followers).length}`
      );
    }
    const total = Object.keys(tracker.data.artists).length;
    const dormant = Object.values(tracker.data.artists).filter(
      (a) => (daysSince(a.last_upload ?? "") ?? 0) > this.dormantDays
    ).length;
    lines.push(
      `Tracked artists: ${total} (${total - dormant} active, ${dormant} dormant)`
    );
    lines.push(`Last check: ${account.data.last_check ?? "Never"}`);
    return lines.join("\n");
  }

  async check(): Promise<string> {
    const tokenErr = await this.ensureToken();
    if (tokenErr) return tokenErr;

    const account = new AccountWatcher(this.api, this.config, this.myTracksLimit, this.log);
    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);

    const [accountNotifs, releases] = await Promise.all([
      account.check(),
      tracker.checkReleases(),
    ]);

    const lines: string[] = [];
    lines.push(`[${utcnow()}] Full check complete\n`);

    lines.push("--- Account ---");
    for (const n of accountNotifs) lines.push(`  ${n}`);
    if (!accountNotifs.length) lines.push("  No updates");

    lines.push("\n--- Artist Releases ---");
    for (const r of releases) lines.push(`  ${r.artist}: ${r.title}`);
    if (!releases.length) lines.push("  No new releases");

    lines.push(`\nAPI calls: ${this.api.calls}`);
    return lines.join("\n");
  }

  async addArtist(username: string): Promise<string> {
    const tokenErr = await this.ensureToken();
    if (tokenErr) return tokenErr;

    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);
    return tracker.add(username);
  }

  async addArtists(usernames: string[]): Promise<string> {
    const tokenErr = await this.ensureToken();
    if (tokenErr) return tokenErr;

    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);
    const results: string[] = [];
    for (const username of usernames) {
      results.push(await tracker.add(username));
    }
    return results.join("\n");
  }

  async removeArtist(username: string): Promise<string> {
    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);
    return tracker.remove(username);
  }

  async listArtists(): Promise<string> {
    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);
    return tracker.list();
  }

  async runCron(): Promise<string | null> {
    const tokenErr = await this.ensureToken();
    if (tokenErr) {
      this.log(tokenErr);
      return null;
    }

    const account = new AccountWatcher(this.api, this.config, this.myTracksLimit, this.log);
    const tracker = new ArtistTracker(this.api, this.dormantDays, this.log);

    const [accountNotifs, releases] = await Promise.all([
      account.check(),
      tracker.checkReleases(),
    ]);

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
      return "SoundCloud updates:\n\n" + lines.join("\n");
    }

    return null;
  }
}
