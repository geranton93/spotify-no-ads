/* no-ads.js — eliminate Spotify desktop ads (free tier) under Spicetify.
 *
 * Goal: no ad should ever be fetched, scheduled, or audible — in-app or between tracks.
 *
 * Layers, most upstream first:
 *   A. Native delivery kill (primary): via module discovery, reach the client's own ads
 *      Settings service (spotify.ads.esperanto.proto.Settings) and
 *        - redirect every known ad slot's ad-server endpoint to a dead loopback URL, so ad
 *          inventory can never be fetched;
 *        - push the in-stream break interval a day out, so no in-stream ad break is scheduled.
 *      Discovery uses the CURRENT module-registry globals (rspackChunk / __webpack_modules__).
 *      NOTE: the pre-update extension (adblockify) used `webpackChunkclient_web |
 *      rspackChunkclient_web`; both were removed in Spotify 1.3.x, which is why it silently
 *      stopped blocking ads after the update.
 *   B. Engine state: publish ad_enabled=false into the native ads engine's state store.
 *   C. Client orchestration: disable every ad manager that exposes disable(), and neutralise
 *      enable()/subscribe paths so the client cannot re-arm them behind our back.
 *   D. Interception: observe in-stream ad messages; if one ever arrives, clear its slot and ask
 *      the engine to skip immediately.
 *   E. Last resort: if an ad still becomes the current playback item, end it and, only while it
 *      is current, force volume to 0 so nothing is audible; restore afterwards from a persisted
 *      checkpoint so a restart can never strand the player muted.
 *
 * Verified NOT to work on Spotify 1.3.0.277 (do not retry blindly):
 *   - putOverridesValues({pairs:{ads:'0'}}) on the product-state service: accepted, but the
 *     effective value stays "1" (checked with getValues and with the ads connector's
 *     subscribeToProductState channel), so the app's adsEnabled gate cannot be flipped this way.
 *   - updateSlotEnabled({slotId, enabled:false}): the engine re-derives enabled=true for an
 *     active free session; the flag is accepted but not honoured.
 *   - displayTimeInterval must NOT be zeroed: it is a refresh interval (leaderboard), and 0 makes
 *     the ad view refresh in a busy loop.
 *
 * Deliberately not used: ad-testing service calls (addPlaytime/insertAd), entitlement changes.
 *
 * Quality (second goal beside ad removal): the extension flips the client's own "adjust quality
 * automatically" switch off (SettingsAPI.quality.autoAdjustQuality, native key audio.allow_downgrade)
 * so the stream is never silently downgraded below what the account is allowed, and it publishes
 * what is actually streaming - NoAds.quality(), and NoAds.verify().quality. It never spoofs the
 * product tier: the ceiling is served by Spotify, not decided by the client, so a free account stays
 * at 160 kbps Ogg and the extension says so out loud instead of pretending otherwise. The same
 * numbers are also a panel - NoAds.qualityPanel(), or Ctrl/Cmd+Shift+Q -
 * showing the setting next to the account's own ceiling pairs (audio-quality / high-bitrate, read
 * from the service the client reads) and what is streaming, with a read-back toggle for the
 * auto-downgrade switch.
 *
 * Interval units (measured on 1.3.0.277): the Settings update* methods take MICROSECONDS while
 * getSlotSettings returns MILLISECONDS — writing 1800000 reads back as 1800000000 in the same
 * call pair, and the client's own leaderboard code consumes the read value as milliseconds
 * (default 20000 = 20 s). So every value below is converted ms -> setter units before sending.
 *
 * Every step is existence-checked, idempotent and re-asserted by a watchdog, because the client
 * re-enables ad managers on player/product-state updates.
 */
(function () {
  'use strict';

  const VERSION = '1.4.0';

  const CFG = {
    killAdServerEndpoint: true,     // A: redirect every ad slot's ad-server endpoint
    pushStreamInterval: true,       // A: push the in-stream ad break interval far out
    engineStateOff: true,           // B: publish ad_enabled=false to the native engine
    disableManagers: true,          // C: disable ad managers and neutralise enable()
    interceptAdMessages: true,      // D: react to in-stream ad messages
    silentLastResort: true,         // E: never let an ad be audible
    // Dead endpoint for A. Loopback, unbound port: connections are refused instantly, so no ad
    // inventory can ever be returned. Change the port if you run something else on it.
    deadUrl: 'http://127.0.0.1:49899/no-ads',
    // Next in-stream ad break is scheduled a day out (see header: default is 825000 ms).
    streamIntervalMs: 86400000,
    // Defaults the client ships with, restored so no slot is left in a degenerate state.
    defaultExpiryMs: 1800000,
    defaultLeaderboardDisplayMs: 20000,
    watchdogMs: 2000,
    reassertNativeMs: 30000,
    reassertStateMs: 30000,
    reassertQualityMs: 30000,
    // Quality policy - the second goal beside ad removal: keep the client from silently downgrading
    // below what the account allows. The knob is SettingsAPI.quality.autoAdjustQuality, native key
    // "audio.allow_downgrade", i.e. a normal user-facing setting, so flipping it is not an
    // entitlement change. The account's own ceiling is *reported*, never faked: on a free tier the
    // streaming service caps at 160 kbps Ogg no matter what the client asks for (measured).
    disableQualityDowngrade: true,
    // Read-only: publish the delivered stream (codec, bitrate, advised bitrate) via NoAds.quality().
    reportQuality: true,
    // The same report as a panel: NoAds.qualityPanel(), and Ctrl/Cmd+Shift+Q.
    qualityPanel: true,
  };

  // Authoritative slot ids from the client's own enum (Slots proto); the engine's live list from
  // getAllSlotSettings() is preferred at runtime, this is the fallback.
  const KNOWN_SLOTS = [
    'preroll', 'stream', 'stream-user-actions', 'hpto', 'leaderboard',
    'embedded-npv', 'embedded-playlist', 'embedded-playlist-leavebehind',
    'podcast-preroll', 'podcast-midroll-1', 'podcast-midroll-2', 'podcast-midroll-3',
    'podcast-midroll-4', 'podcast-midroll-5', 'podcast-postroll',
  ];

  // Intervals: getters speak milliseconds, update* setters speak microseconds (see header).
  const toSetterUnits = (ms) => BigInt(Math.round(ms / 1000));

  const VOLUME_KEY = 'no-ads.restore-volume.v1';

  const state = {
    version: VERSION,
    counters: { nativeApplies: 0, stateApplies: 0, managerDisables: 0, enableBlocks: 0,
                adMessages: 0, guards: 0, mutes: 0, managerReasserts: 0, errors: 0 },
    applied: { native: false, nativeAt: null, stateOff: false, stateAt: null, intercept: false,
               managers: [], settingsClient: false },
    observed: { adsProductValue: null, audioEnabled: null, vtoEnabled: null,
                adEnabledEngine: null, lastAdAt: null, quality: null },
    log: [],
    lastError: null,
  };

  function log(msg, extra) {
    const entry = { t: new Date().toISOString(), msg: msg };
    if (extra !== undefined) entry.extra = extra;
    state.log.push(entry);
    if (state.log.length > 100) state.log.shift();
  }
  function note(fn, what) {
    try { return fn(); }
    catch (e) { state.counters.errors++; state.lastError = what + ': ' + (e && e.message); log('error', state.lastError); }
  }

  const S = () => globalThis.Spicetify;
  const AM = () => S()?.Platform?.AdManagers;
  const getConnector = () =>
    AM()?.audio?.inStreamApi?.adsCoreConnector || AM()?.inStreamApi?.adsCoreConnector || null;
  const getTransport = () =>
    S()?.Platform?.ProductStateAPI?.productStateApi?.transport ||
    S()?.Platform?.UserAPI?._product_state?.transport ||
    S()?.Platform?.UserAPI?._product_state_service?.transport || null;

  /* ---------- module discovery (new registry) ---------- */

  let serviceBag = null;

  function discoverAdsServices() {
    if (serviceBag) return serviceBag;
    // New-style globals. The legacy webpackChunkclient_web / rspackChunkclient_web are gone in
    // 1.3.x — this is the exact reason the previous extension stopped working after an update.
    const chunk = globalThis.rspackChunk || globalThis.webpackChunkclient_web ||
                  globalThis.rspackChunkclient_web;
    const modules = globalThis.__webpack_modules__;
    const bag = {};
    const collect = (moduleExports) => {
      if (!moduleExports) return;
      let values;
      try { values = Object.values(moduleExports); } catch (e) { return; }
      for (const value of values) {
        if (value && typeof value === 'function' && typeof value.SERVICE_ID === 'string' &&
            value.SERVICE_ID.indexOf('ads.esperanto') !== -1) {
          bag[value.SERVICE_ID] = value;
        }
      }
    };
    if (modules && typeof modules === 'object') {
      for (const id of Object.keys(modules)) note(() => collect(modules[id]), 'scan __webpack_modules__');
    }
    if (!Object.keys(bag).length && chunk && typeof chunk.push === 'function') {
      const require = note(() => chunk.push([[Symbol()], {}, (n) => n]), 'registry require');
      const map = require && require.m;
      if (map) for (const id of Object.keys(map)) note(() => collect(require(id)), 'scan registry module');
    }
    if (!Object.keys(bag).length) { log('ads service classes not found in module registry'); return null; }
    log('ads service classes discovered', Object.keys(bag).length);
    serviceBag = bag;
    return bag;
  }

  function getSettingsClient() {
    const bag = discoverAdsServices();
    const ServiceClass = bag && bag['spotify.ads.esperanto.proto.Settings'];
    if (!ServiceClass) return null;
    const transport = getTransport();
    if (!transport) return null;
    return note(() => new ServiceClass(transport), 'construct Settings client');
  }

  /* ---------- A. native slot settings ---------- */

  // The engine's own slot list is authoritative: read it, fall back to the static enum.
  async function resolveSlotIds(settings) {
    if (typeof settings.getAllSlotSettings === 'function') {
      const all = note(() => settings.getAllSlotSettings({}), 'getAllSlotSettings');
      const ids = all && all.slotSettings ? all.slotSettings.map((s) => s.id).filter(Boolean) : null;
      if (ids && ids.length) {
        const merged = [...new Set([...ids, ...KNOWN_SLOTS])];
        state.applied.slots = merged;
        return merged;
      }
    }
    state.applied.slots = KNOWN_SLOTS;
    return KNOWN_SLOTS;
  }

  async function applyNativeSettings() {
    if (!CFG.killAdServerEndpoint && !CFG.pushStreamInterval) return;
    const settings = getSettingsClient();
    if (!settings) { log('ads Settings service unreachable — native layer skipped'); return; }
    state.applied.settingsClient = true;
    const slotIds = await resolveSlotIds(settings);

    if (CFG.killAdServerEndpoint && typeof settings.updateAdServerEndpoint === 'function') {
      await settings.updateAdServerEndpoint({ slotIds, url: CFG.deadUrl });
      log('ad-server endpoint redirected', slotIds.length + ' slots');
    }
    if (CFG.pushStreamInterval && typeof settings.updateStreamTimeInterval === 'function') {
      const interval = toSetterUnits(CFG.streamIntervalMs);
      for (const slotId of ['stream', 'preroll']) {
        // Best effort: the engine owns the effective value; honoured on 1.3.0.277.
        await settings.updateStreamTimeInterval({ slotId, timeInterval: interval });
      }
      log('in-stream break interval pushed out', CFG.streamIntervalMs + 'ms');
    }
    // Never leave a slot in a degenerate state: 0 would busy-refresh the leaderboard ad view,
    // and a zeroed expiry would make the client re-request inventory in a loop.
    if (typeof settings.updateExpiryTimeInterval === 'function') {
      const expiry = toSetterUnits(CFG.defaultExpiryMs);
      for (const slotId of slotIds) await settings.updateExpiryTimeInterval({ slotId, timeInterval: expiry });
    }
    if (typeof settings.updateDisplayTimeInterval === 'function') {
      await settings.updateDisplayTimeInterval({ slotId: 'leaderboard',
                                                 timeInterval: toSetterUnits(CFG.defaultLeaderboardDisplayMs) });
    }
    state.counters.nativeApplies++;
    state.applied.native = true;
    state.applied.nativeAt = new Date().toISOString();
  }

  /* ---------- B. native engine state ---------- */

  async function applyEngineState() {
    if (!CFG.engineStateOff) return;
    const connector = getConnector();
    if (!connector || typeof connector.putState !== 'function') return;
    await connector.putState('ad_enabled', 'false');
    state.counters.stateApplies++;
    state.applied.stateOff = true;
    state.applied.stateAt = new Date().toISOString();

    // Best effort: disable slots natively. The engine re-derives enabled=true for an active free
    // session on 1.3.0.277, so this is not relied upon — the endpoint redirect does the work.
    const settings = getSettingsClient();
    if (settings && typeof settings.updateSlotEnabled === 'function') {
      for (const slotId of (state.applied.slots || KNOWN_SLOTS)) {
        note(() => settings.updateSlotEnabled({ slotId, enabled: false }), 'updateSlotEnabled ' + slotId);
      }
    }
  }

  async function readEngineState() {
    const connector = getConnector();
    if (!connector || typeof connector.getAdState !== 'function') return null;
    const adState = await connector.getAdState();
    const bucket = adState && adState.state;
    return {
      ad_enabled: bucket && bucket.ad_enabled && bucket.ad_enabled.value,
      ad_break_time: bucket && bucket.ad_break_time && bucket.ad_break_time.value,
      raw: bucket ? Object.keys(bucket).length : 0,
    };
  }

  /* ---------- C. client orchestration ---------- */

  function managerTargets() {
    const managers = AM();
    if (!managers) return {};
    return {
      'audio': managers.audio,
      'audio.inStreamApi': managers.audio && managers.audio.inStreamApi,
      'inStreamApi': managers.inStreamApi,
      'vto.manager': managers.vto && managers.vto.manager,
      'leaderboard': managers.leaderboard,
      'home': managers.home,
      'survey': managers.survey,
      'embeddedAd.embeddedAdManager': managers.embeddedAd && managers.embeddedAd.embeddedAdManager,
      'embeddedPlaylist.embeddedPlaylistManager':
        managers.embeddedPlaylist && managers.embeddedPlaylist.embeddedPlaylistManager,
    };
  }

  function disableManagers() {
    if (!CFG.disableManagers) return;
    const disabled = [];
    for (const [name, target] of Object.entries(managerTargets())) {
      if (!target) continue;
      if (typeof target.disableLeaderboard === 'function') note(() => target.disableLeaderboard(), name);
      if (typeof target.disable === 'function') { note(() => target.disable(), name + '.disable'); disabled.push(name); }
      // Block re-arming: neutralise enable() so the client cannot re-subscribe behind our back.
      if (typeof target.enable === 'function' && !target.__noAdsEnableBlocked) {
        const originalEnable = target.enable.bind(target);
        target.enable = function () {
          state.counters.enableBlocks++;
          log('blocked re-enable', name);
          return undefined;
        };
        target.__noAdsEnableBlocked = true;
        target.__noAdsOriginalEnable = originalEnable;
      }
    }
    if (disabled.length) {
      state.counters.managerDisables++;
      state.applied.managers = disabled;
      log('ad managers disabled', disabled.join(','));
    }
  }

  function managersEnabled() {
    const read = (obj) => {
      if (!obj) return null;
      if (typeof obj.getEnabled === 'function') return note(() => obj.getEnabled(), 'getEnabled');
      if (typeof obj.enabled === 'boolean') return obj.enabled;
      return null;
    };
    const managers = AM();
    if (!managers) return null;
    return {
      audio: read(managers.audio),
      inStreamApi: read(managers.audio && managers.audio.inStreamApi) ?? read(managers.inStreamApi),
      vto: read(managers.vto && managers.vto.manager),
      leaderboard: read(managers.leaderboard),
    };
  }

  /* ---------- D. interception ---------- */

  function installInterception() {
    const connector = getConnector();
    if (!connector || connector.__noAdsPatched) return;

    if (typeof connector.createSlot === 'function') {
      const originalCreateSlot = connector.createSlot.bind(connector);
      connector.createSlot = function (slotId, format) {
        const result = originalCreateSlot(slotId, format);
        note(() => {
          const settings = getSettingsClient();
          if (settings && typeof settings.updateAdServerEndpoint === 'function' && slotId) {
            settings.updateAdServerEndpoint({ slotIds: [slotId], url: CFG.deadUrl });
          }
        }, 'endpoint for new slot ' + slotId);
        return result;
      };
    }

    if (CFG.interceptAdMessages && typeof connector.subscribeToInStreamAds === 'function') {
      const originalSubscribe = connector.subscribeToInStreamAds.bind(connector);
      connector.subscribeToInStreamAds = function (callback) {
        return originalSubscribe(function (message) {
          state.counters.adMessages++;
          state.observed.lastAdAt = new Date().toISOString();
          log('in-stream ad message received', message && message.ad ? 'with ad payload' : 'empty');
          void note(() => connector.skipToNext && connector.skipToNext(), 'skipToNext');
          void note(() => connector.clearSlot && connector.clearSlot('stream'), 'clearSlot(stream)');
          void note(() => connector.clearSlot && connector.clearSlot('preroll'), 'clearSlot(preroll)');
          if (typeof callback === 'function') note(() => callback(message), 'app ad callback');
        });
      };
    }

    connector.__noAdsPatched = true;
    state.applied.intercept = true;
    log('interception installed');
  }

  /* ---------- E. last-resort playback guard ---------- */

  const isAdItem = (item) => !!item && (
    item.type === 'ad' ||
    String(item.uri || '').startsWith('spotify:ad:') ||
    String(item.metadata && item.metadata.is_advertisement) === 'true'
  );

  function loadCheckpoint() {
    return note(() => {
      const raw = globalThis.localStorage.getItem(VOLUME_KEY);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      return (typeof value === 'number' && value >= 0 && value <= 1) ? value : null;
    }, 'loadCheckpoint');
  }
  function saveCheckpoint(value) {
    note(() => {
      if (value === null) globalThis.localStorage.removeItem(VOLUME_KEY);
      else globalThis.localStorage.setItem(VOLUME_KEY, JSON.stringify(value));
    }, 'saveCheckpoint');
  }

  let checkpoint = loadCheckpoint();

  function guard() {
    const player = S() && S().Player;
    if (!player || !player.data) return;
    const item = player.data.item;
    if (isAdItem(item)) {
      state.counters.guards++;
      const connector = getConnector();
      note(() => connector && connector.skipToNext && connector.skipToNext(), 'guard skipToNext');
      note(() => connector && connector.clearSlot && connector.clearSlot('stream'), 'guard clearSlot');
      note(() => player.next && player.next(), 'guard Player.next');
      if (CFG.silentLastResort && typeof player.getVolume === 'function' &&
          typeof player.setVolume === 'function') {
        const volume = player.getVolume();
        if (typeof volume === 'number' && volume > 0) {
          if (checkpoint === null) { checkpoint = volume; saveCheckpoint(checkpoint); }
          player.setVolume(0);
          state.counters.mutes++;
          log('ad reached playback — muted as last resort');
        }
      }
      return;
    }
    if (checkpoint !== null && typeof player.getVolume === 'function' &&
        typeof player.setVolume === 'function') {
      if (player.getVolume() === 0) {
        player.setVolume(checkpoint);
        if (player.getVolume() === 0) return;    // restore not observed yet: keep the checkpoint
      }
      log('volume restored', checkpoint);
      checkpoint = null;
      saveCheckpoint(null);
    }
  }

  /* ---------- F. UI hygiene: upsell surfaces ---------- */

  function applyUiFlags() {
    note(() => {
      const key = 'spicetify-exp-features';
      const wanted = { hideUpgradeCTA: true, enableInAppMessaging: false };
      const features = JSON.parse(globalThis.localStorage.getItem(key) || '{}');
      let changed = false;
      for (const [name, value] of Object.entries(wanted)) {
        if (features[name] && typeof features[name].value === 'boolean' && features[name].value !== value) {
          features[name].value = value;
          changed = true;
        }
      }
      if (changed) globalThis.localStorage.setItem(key, JSON.stringify(features));
      // Apply live as well, so the UI reacts without waiting for a restart.
      if (S() && S().RemoteConfigResolver && typeof S().createInternalMap === 'function') {
        S().RemoteConfigResolver.value.setOverrides(S().createInternalMap(wanted));
      } else if (S() && S().Platform && S().Platform.RemoteConfigDebugAPI) {
        for (const [name, value] of Object.entries(wanted)) {
          S().Platform.RemoteConfigDebugAPI.setOverride({ source: 'web', type: 'boolean', name: name }, value);
        }
      }
      if (changed) log('ui flags applied', JSON.stringify(wanted));
    }, 'ui flags');
  }

  /* ---------- G. ad container CSS ---------- */

  function applyCss() {
    if (document.getElementById('no-ads-style')) return;
    const style = document.createElement('style');
    style.id = 'no-ads-style';
    style.textContent = [
      // ad surfaces
      [
        '.main-leaderboardComponent-container',
        '.sponsor-container',
        'div[data-testid*="hpto"]',
        '.main-topBar-UpgradeButton',
      ].join(', ') + ' { display: none !important; }',

      // Top bar hairline. Spotify's own separator between the action area and the profile avatar is
      // declared as a 1px line (clean bundle: background:#fff;width:1px;height:25px;margin:16px),
      // but the same element also carries the action-buttons class, whose padding-inline:8px 0
      // widens the border box to 8px under box-sizing:border-box - and the background paints the
      // padding box, so the divider renders as an 8x25 white block. Restore the declared hairline.
      // To drop the separator entirely instead, set 'display: none !important;' here.
      '.main-actionButtons-spacer { width: 1px !important; min-width: 1px !important;'
      + ' padding-inline: 0 !important; flex: 0 0 auto !important; }',
      // Top bar history spacer. Spotify ships two distinct classes for this spacer - the macOS
      // window-controls layout wants 52x12, the other layout 28x16 - and Spicetify's css-map maps
      // BOTH obfuscated names onto this one class, so the later rule (28x16) wins everywhere. On
      // macOS that leaves the spacer 24px too narrow and the back/forward buttons crowd the traffic
      // lights. Restore the macOS variant (measured: chevrons move from x=81 to x=105).
      '.main-globalNav-historyButtonsSpacer { width: calc(52px / (var(--zoom-level,100) / 100)) !important;'
      + ' height: calc(12px / (var(--zoom-level,100) / 100)) !important; }',

      // Marketplace nav chip. Spicetify renders custom nav links inside the history cluster, where
      // every neighbour is a plain icon, but the Marketplace app draws its entry as a filled chip
      // (48x48, background rgb(36,36,36)) - so it reads as a stray element between the chevrons and
      // the empty middle of the bar. Keep the hit area and leave :hover alone so the button still
      // gives feedback; only the resting fill goes away. Selector is class-based, not label-based,
      // because the label is localised.
      '[class*="custom-navlinks"] button:not(:hover) { background: transparent !important; }',
    ].join('\n');
    document.head.appendChild(style);
    log('ad container CSS installed');
  }

  /* ---------- watchdog ---------- */

  let lastNative = Date.now();
  let lastState = Date.now();
  let lastQuality = Date.now();
  let disposed = false;

  function watchdog() {
    if (disposed) return;
    if (!AM()) return;
    const enabled = managersEnabled();
    if (enabled) {
      state.observed.audioEnabled = enabled.audio;
      state.observed.vtoEnabled = enabled.vto;
      if (enabled.audio === true || enabled.inStreamApi === true || enabled.vto === true) {
        state.counters.managerReasserts++;
        log('ad manager re-enabled by client — re-disabling', JSON.stringify(enabled));
        disableManagers();
      }
    }
    const now = Date.now();
    if (now - lastNative > CFG.reassertNativeMs) {
      lastNative = now;
      void note(() => applyNativeSettings(), 'native re-assert');
    }
    if (now - lastState > CFG.reassertStateMs) {
      lastState = now;
      void note(() => applyEngineState(), 'engine-state re-assert');
      void note(async () => {
        const st = await readEngineState();
        if (st) state.observed.adEnabledEngine = st.ad_enabled;
      }, 'read engine state');
    }
    if (CFG.reportQuality && now - lastQuality > CFG.reassertQualityMs) {
      lastQuality = now;
      void refreshQuality().catch(() => {});
    }
    installInterception();
    applyUiFlags();
    applyCss();
    registerQualityEntry();
    guard();
  }

  /* ---------- H. playback quality (policy + honest report) ---------- */

  let playbackClass = null;

  // The playback service is not an ads service, so it is discovered on its own: the class whose
  // prototype carries getPlaybackInfo(). Cached after the first scan.
  function findPlaybackClass() {
    if (playbackClass) return playbackClass;
    const chunk = globalThis.rspackChunk || globalThis.webpackChunkclient_web ||
                  globalThis.rspackChunkclient_web;
    if (!chunk || typeof chunk.push !== 'function') return null;
    try {
      const require = chunk.push([[Symbol()], {}, (n) => n]);
      for (const id of Object.keys(require.m || {})) {
        let moduleExports;
        try { moduleExports = require(id); } catch (e) { continue; }
        if (!moduleExports) continue;
        for (const value of Object.values(moduleExports)) {
          if (typeof value === 'function' && value.prototype &&
              typeof value.prototype.getPlaybackInfo === 'function') {
            playbackClass = value;
            log('playback service class discovered');
            return playbackClass;
          }
        }
      }
    } catch (e) { state.lastError = 'playback scan: ' + (e && e.message); }
    return null;
  }

  const qualitySettings = () => {
    const q = S()?.Platform?.SettingsAPI?.quality;
    return q && typeof q === 'object' ? q : null;
  };

  async function readSetting(field) {
    const q = qualitySettings();
    if (!q || !q[field] || typeof q[field].getValue !== 'function') return null;
    try { return await q[field].getValue(); } catch (e) { return null; }
  }

  // Read-only. Makes the ceiling visible instead of guessed: what the setting asks for, what the
  // account is allowed, and what is actually streaming right now.
  async function readQuality() {
    const out = {
      streamingQualitySetting: await readSetting('streamingQuality'),
      accountCap: await readSetting('maxSupportedQuality'),
      autoDowngrade: await readSetting('autoAdjustQuality'),
      normalizeVolume: await readSetting('normalizeVolume'),
      volumeLevel: await readSetting('volumeLevel'),
      downloadQualitySetting: await readSetting('downloadAudioQuality'),
      codec: null, bitrate: null, targetBitrate: null, advisedBitrate: null, strategy: null,
      source: null, account: null,
    };
    out.account = await readAccountState();
    out.source = describeSource(null);
    const PB = findPlaybackClass();
    const transport = getTransport();
    if (PB && transport) {
      try {
        const info = await new PB(transport).getPlaybackInfo();
        if (info) {
          out.codec = info.codecName || null;
          out.bitrate = info.fileBitrate == null ? null : String(info.fileBitrate);
          out.targetBitrate = info.targetBitrate == null ? null : String(info.targetBitrate);
          out.advisedBitrate = info.advisedBitrate == null ? null : String(info.advisedBitrate);
          out.strategy = info.strategy || null;
          out.source = describeSource(out.strategy);
        }
      } catch (e) { out.streamError = (e && e.message) || String(e); }
    }
    if (out.accountCap !== null && out.bitrate !== null) {
      const kbps = Math.round(Number(out.bitrate) / 1000);
      const tier = (out.account && out.account.name) ? out.account.name : 'unknown tier';
      const caps = out.account && out.account.audioQuality !== undefined
        ? ' (audio-quality=' + out.account.audioQuality + ', high-bitrate=' + out.account.highBitrate + ')'
        : '';
      out.note = (Number(out.accountCap) === 0)
        ? tier + caps + ' caps the stream (' + kbps + ' kbps ' + (out.codec || '') + '): those pairs '
          + 'are served by Spotify with the session and the client already asks for its maximum, so '
          + 'no web-layer change can raise it'
        : 'account allows the configured quality (' + kbps + ' kbps ' + (out.codec || '') + ')';
    }
    return out;
  }

  async function refreshQuality() {
    if (!CFG.reportQuality) return;
    state.observed.quality = await readQuality();
  }

  // The one quality lever that is legitimately ours to flip: the client's own "adjust quality
  // automatically" switch (audio.allow_downgrade). It only stops silent downgrades below the tier -
  // it never asks for more than the account owns, and the report above always states the truth.
  async function applyQualityPolicy() {
    if (!CFG.disableQualityDowngrade) return;
    const q = qualitySettings();
    if (!q || !q.autoAdjustQuality || typeof q.autoAdjustQuality.setValue !== 'function') return;
    try {
      const before = await q.autoAdjustQuality.getValue();
      if (before === true) {
        await q.autoAdjustQuality.setValue(false);
        const after = await q.autoAdjustQuality.getValue();
        state.applied.qualityDowngradeDisabled = (after === false);
        log('quality auto-downgrade disabled', 'read back: ' + String(after));
      } else {
        state.applied.qualityDowngradeDisabled = true;
      }
    } catch (e) {
      state.counters.errors++;
      state.lastError = 'quality policy: ' + (e && e.message);
      log('error', state.lastError);
    }
  }

  /* ---------- I. the account's own numbers ---------- */

  // Section H reports what the *client* is allowed. These pairs report what the *account* is
  // allowed, read from the service the client itself reads. "audio-quality" and "high-bitrate"
  // arrive with the session, which is the structural reason the cap cannot be raised from the web
  // layer: the call that tries (putOverridesValues) is accepted and changes nothing - measured, the
  // read-back and the stream were identical at +1.5s and +8s.
  const productStateApi = () =>
    S()?.Platform?.UserAPI?._product_state_service ||
    S()?.Platform?.ProductStateAPI?.productStateApi ||
    S()?.Platform?.UserAPI?._product_state || null;

  async function readAccountState() {
    const api = productStateApi();
    if (!api || typeof api.getValues !== 'function') return null;
    try {
      const res = await api.getValues({
        keys: ['ads', 'catalogue', 'type', 'name', 'audio-quality', 'high-bitrate', 'financial-product'],
      });
      const pairs = (res && res.pairs) || res || {};
      return {
        name: pairs.name ?? null,
        catalogue: pairs.catalogue ?? null,
        type: pairs.type ?? null,
        ads: pairs.ads ?? null,
        audioQuality: pairs['audio-quality'] ?? null,
        highBitrate: pairs['high-bitrate'] ?? null,
        financialProduct: pairs['financial-product'] ?? null,
        tierCapsStream: String(pairs['audio-quality'] ?? '') === '0',
      };
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }

  // Where the sound comes from right now: local files and cached copies are served without the
  // network and without the tier's stream cap, so this is the line that explains most "why does it
  // sound like this" questions.
  function describeSource(strategy) {
    const uri = String((S()?.Player?.data?.item && S().Player.data.item.uri) || '');
    if (uri.startsWith('spotify:local:')) return 'local file (own bitrate, plays offline)';
    if (!uri) return 'nothing playing';
    if (strategy === 'cached file') return 'cached copy of the stream';
    return 'network stream';
  }

  /* ---------- J. quality panel ---------- */

  const PANEL_ID = 'no-ads-quality-panel';
  const PANEL_STYLE_ID = 'no-ads-quality-style';
  let panelKeyHandler = null;

  function ensurePanelStyle() {
    if (document.getElementById(PANEL_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PANEL_STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + ' { position: fixed; top: 64px; right: 16px; width: 420px;',
      '  max-width: calc(100vw - 32px); z-index: 9999; background: var(--spice-card, #282828);',
      '  color: var(--spice-text, #ffffff); border: 1px solid rgba(255,255,255,.12); border-radius: 8px;',
      '  padding: 14px 16px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 13px; line-height: 1.45;',
      '  user-select: text; }',
      '#' + PANEL_ID + ' h3 { margin: 0 0 10px; font-size: 14px; font-weight: 700; }',
      '#' + PANEL_ID + ' .na-row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }',
      '#' + PANEL_ID + ' .na-row span:last-child { text-align: right; }',
      '#' + PANEL_ID + ' .na-dim { opacity: .7; }',
      '#' + PANEL_ID + ' .na-note, #' + PANEL_ID + ' .na-levers { margin-top: 10px; padding-top: 10px;',
      '  border-top: 1px solid rgba(255,255,255,.12); opacity: .85; }',
      '#' + PANEL_ID + ' .na-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }',
      '#' + PANEL_ID + ' button { background: rgba(255,255,255,.1); color: inherit; border: 0;',
      '  border-radius: 500px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }',
      '#' + PANEL_ID + ' button:hover { background: rgba(255,255,255,.2); }',
      '#' + PANEL_ID + ' label { display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function closeQualityPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    if (panelKeyHandler) {
      document.removeEventListener('keydown', panelKeyHandler, true);
      panelKeyHandler = null;
    }
  }

  const row = (label, value) =>
    '<div class="na-row"><span class="na-dim">' + label + '</span><span>' + value + '</span></div>';

  const kbps = (bits) => (bits === null || bits === undefined)
    ? 'n/a' : Math.round(Number(bits) / 1000) + ' kbps';

  // Read-only except for the one user-facing switch, which is applied and read back through the
  // client's own API before the panel says anything about it.
  async function openQualityPanel() {
    ensurePanelStyle();
    closeQualityPanel();
    const quality = await readQuality();
    const account = quality.account || {};
    const caps = (account.audioQuality === undefined)
      ? '' : '  (audio-quality=' + account.audioQuality + ', high-bitrate=' + account.highBitrate + ')';
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = [
      '<h3>no-ads ' + state.version + ' - quality</h3>',
      row('Account', (account.name || 'unknown') + (account.catalogue ? ' (' + account.catalogue + ')' : '')),
      row('Setting for streaming', String(quality.streamingQualitySetting ?? 'n/a')),
      row('Account allows', String(quality.accountCap ?? 'n/a') + caps),
      row('Streaming now', kbps(quality.bitrate) + ' ' + (quality.codec || '') + '  (target ' + kbps(quality.targetBitrate) + ')'),
      row('Source', quality.source || 'n/a'),
      row('Connection could carry', kbps(quality.advisedBitrate)),
      row('Never downgrade automatically', quality.autoDowngrade === false ? 'on' : 'off'),
      '<div class="na-note">' + (quality.note || 'no stream information yet') + '</div>',
      '<div class="na-levers">What actually raises quality: your own files (played at their native '
        + 'bitrate, and they work offline), a wired output instead of Bluetooth, or Premium for the '
        + 'catalogue at 320 kbps. The tier itself is served by Spotify and cannot be raised here.</div>',
      '<label><input type="checkbox" id="no-ads-auto-downgrade"'
        + (quality.autoDowngrade === false ? ' checked' : '') + '> stop the client lowering quality on its own</label>',
      '<div class="na-actions"><button id="no-ads-copy">Copy report</button>'
        + '<button id="no-ads-close">Close</button></div>',
    ].join('');
    document.body.appendChild(panel);

    const toggle = panel.querySelector('#no-ads-auto-downgrade');
    if (toggle) {
      toggle.addEventListener('change', () => {
        const q = qualitySettings();
        const autoAdjust = !toggle.checked;   // checked = "do not lower quality" => autoAdjustQuality false
        note(async () => {
          if (q && q.autoAdjustQuality && typeof q.autoAdjustQuality.setValue === 'function') {
            await q.autoAdjustQuality.setValue(autoAdjust);
            const after = await q.autoAdjustQuality.getValue();
            state.applied.qualityDowngradeDisabled = (after === false);
            log('auto-downgrade toggled from the panel', 'read back: ' + String(after));
            void refreshQuality();
          }
        }, 'panel toggle');
      });
    }
    const closeButton = panel.querySelector('#no-ads-close');
    if (closeButton) closeButton.addEventListener('click', closeQualityPanel);
    const copyButton = panel.querySelector('#no-ads-copy');
    if (copyButton) {
      copyButton.addEventListener('click', () => note(
        () => globalThis.navigator.clipboard.writeText(JSON.stringify(quality, null, 1)), 'copy report'));
    }

    panelKeyHandler = (event) => { if (event.key === 'Escape') closeQualityPanel(); };
    document.addEventListener('keydown', panelKeyHandler, true);
    log('quality panel opened');
    return quality;
  }

  // Entry points beyond the console function. Both are optional surfaces of this build, so each is
  // feature-detected: if a build drops Spicetify.Menu or Spicetify.Keyboard, the report still works
  // through NoAds.qualityPanel().
  // Ctrl/Cmd+Shift+Q is bound with our own DOM listener rather than Spicetify's optional surfaces,
  // because both were measured unusable in this combination (Spotify 1.3.0.277 + Spicetify 2.45.1):
  //   - Spicetify.Menu.Item.register() funnels into ContextMenuV2.registerItem with an element the
  //     constructor builds through a `jsx` helper this build does not expose (typeof jsx is
  //     undefined), so it throws "Cannot read properties of undefined (reading 'jsx')" and no menu
  //     entry appears;
  //   - Spicetify.Keyboard.registerShortcut() accepts the binding without error, but a real
  //     Ctrl+Shift+Q dispatched through the devtools Input domain never reaches the callback.
  // Our own listener depends on nothing but the DOM, so it is verifiable - and NoAds.qualityPanel()
  // is always available from the console as a fallback.
  let qualityKeyHandler = null;

  function registerQualityEntry() {
    if (!CFG.qualityPanel || qualityKeyHandler) return;
    qualityKeyHandler = (event) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      if (String(event.key).toLowerCase() !== 'q') return;
      event.preventDefault();
      event.stopPropagation();
      if (document.getElementById(PANEL_ID)) closeQualityPanel();
      else void openQualityPanel().catch(() => {});
    };
    window.addEventListener('keydown', qualityKeyHandler, true);
    state.applied.qualityShortcut = 'Ctrl/Cmd+Shift+Q';
    log('quality shortcut registered');
  }

  /* ---------- bootstrap ---------- */

  const timers = [];
  const listeners = [];

  function start() {
    if (!S() || !AM() || !S().Player || typeof S().Player.addEventListener !== 'function') {
      setTimeout(start, 500);
      return;
    }
    if (globalThis.NoAds && globalThis.NoAds.version) {
      log('no-ads already active, skipping duplicate start');
      return;
    }

    globalThis.NoAds = state;
    state.verify = function () {
      return JSON.stringify({
        version: state.version,
        counters: state.counters,
        applied: state.applied,
        observed: state.observed,
        managers: managersEnabled(),
        quality: state.observed.quality,
        settingsServiceReachable: !!state.applied.settingsClient,
        connectorPresent: !!getConnector(),
        log: state.log.slice(-20),
        lastError: state.lastError,
      }, null, 1);
    };
    state.quality = function () {
      return readQuality().then((q) => JSON.stringify(q, null, 1));
    };
    state.qualityPanel = function () { return openQualityPanel(); };
    state.reapply = function () {
      void note(() => applyNativeSettings(), 'manual native');
      void note(() => applyEngineState(), 'manual state');
      disableManagers();
      installInterception();
    };
    state.dispose = function () {
      disposed = true;
      closeQualityPanel();
      if (qualityKeyHandler) {
        window.removeEventListener('keydown', qualityKeyHandler, true);
        qualityKeyHandler = null;
      }
      for (const t of timers) clearInterval(t);
      for (const l of listeners) note(() => l(), 'remove listener');
      for (const target of Object.values(managerTargets())) {
        if (target && target.__noAdsEnableBlocked && target.__noAdsOriginalEnable) {
          target.enable = target.__noAdsOriginalEnable;
          delete target.__noAdsEnableBlocked;
          delete target.__noAdsOriginalEnable;
        }
      }
      const connector = getConnector();
      if (connector) delete connector.__noAdsPatched;
      if (globalThis.NoAds === state) delete globalThis.NoAds;
    };

    log('no-ads starting', S().version);
    void applyQualityPolicy().catch(() => {});
    void refreshQuality().catch(() => {});
    registerQualityEntry();
    void note(() => applyNativeSettings(), 'initial native');
    void note(async () => { await applyEngineState(); state.observed.adEnabledEngine = (await readEngineState())?.ad_enabled; }, 'initial engine state');
    disableManagers();
    installInterception();

    note(() => {
      const listener = S().Player.addEventListener('songchange', guard);
      listeners.push(listener);
    }, 'songchange listener');

    timers.push(setInterval(watchdog, CFG.watchdogMs));
    watchdog();
    log('no-ads active');
  }

  if (globalThis.NoAds && typeof globalThis.NoAds.dispose === 'function') {
    try { globalThis.NoAds.dispose(); } catch (e) {}
  }
  start();
})();
