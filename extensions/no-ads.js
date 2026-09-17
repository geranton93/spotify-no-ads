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

  const VERSION = '1.2.0';

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
                adEnabledEngine: null, lastAdAt: null },
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
      '.main-leaderboardComponent-container',
      '.sponsor-container',
      'div[data-testid*="hpto"]',
      '.main-topBar-UpgradeButton',
    ].join(', ') + ' { display: none !important; }';
    document.head.appendChild(style);
    log('ad container CSS installed');
  }

  /* ---------- watchdog ---------- */

  let lastNative = Date.now();
  let lastState = Date.now();
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
    installInterception();
    applyUiFlags();
    applyCss();
    guard();
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
        settingsServiceReachable: !!state.applied.settingsClient,
        connectorPresent: !!getConnector(),
        log: state.log.slice(-20),
        lastError: state.lastError,
      }, null, 1);
    };
    state.reapply = function () {
      void note(() => applyNativeSettings(), 'manual native');
      void note(() => applyEngineState(), 'manual state');
      disableManagers();
      installInterception();
    };
    state.dispose = function () {
      disposed = true;
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
