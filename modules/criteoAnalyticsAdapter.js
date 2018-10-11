import {ajax} from 'src/ajax';
import adapter from 'src/AnalyticsAdapter';
import CONSTANTS from 'src/constants.json';
import adaptermanager from 'src/adaptermanager';
import {deepClone, logInfo} from 'src/utils';

const {
  EVENTS: {
    AUCTION_INIT,
    AUCTION_END
  }
} = CONSTANTS;

const ANALYTICS_ENDPOINT = '//bidder.criteo.com/prebid/analytics';
const DEFAULT_SAMPLING_PERCENTAGE = 100;
const DEFAULT_SEND_DELAY = 3000;
const PERFORMANCE_ENTRIES_EVENT_TYPE = 'performanceEntries';

let auctionStartTime = 0;
let eventCache = {};
let samplingPercentage;
let sendDelay;

let criteoAdapter = Object.assign(adapter({
  analyticsType: 'bundle'
}), {
  track({ eventType, args }) {
    switch (eventType) {
      // On the first event auction init, fix the time origin to compute duration for further events and cache the event
      case AUCTION_INIT:
        initAuctionStartTime(args);
        cacheEvent(eventType, args);
        break;
      // On auction end event cache the event
      // After a delay (to ensure we dont miss events (eg.: setTargeting, bidWon, bidderDone etc.)) add performance entries events, flush the cache and send its content to analytics endpoint
      // Note some events may still be missed (eg.: bidTimeout) if they appear after this delay value (/?\ should we still send them in a second batch ?)
      case AUCTION_END:
        cacheEvent(eventType, args);
        setTimeout(() => {
          cachePerformanceEntriesEvents();
          sendCachedEvents()
        }, sendDelay);
        break;
        // For other events only cache them
      default:
        cacheEvent(eventType, args)
        break;
    }
  }
});

// To access configuration keep reference to the original enableAnalytics function and override it
criteoAdapter.originEnableAnalytics = criteoAdapter.enableAnalytics;
criteoAdapter.enableAnalytics = function (config) {
  samplingPercentage = config.options && typeof config.options.samplingPercentage === 'number' &&
    config.options.samplingPercentage >= 0 && config.options.samplingPercentage <= 100 ? config.options.samplingPercentage : DEFAULT_SAMPLING_PERCENTAGE;
  sendDelay = config.options && typeof config.options.sendDelay === 'number' ? config.options.sendDelay : DEFAULT_SEND_DELAY;
  criteoAdapter.originEnableAnalytics(config); // call the base function
};

function initAuctionStartTime(actionInitEvent) {
  auctionStartTime = actionInitEvent.timestamp || Date.now();
}

function cacheEvent(eventType, event) {
  // Init event cache for this event type if required
  if (!eventCache[eventType]) {
    eventCache[eventType] = [];
  }

  // Clone event to not modify the same reference at each event (bidRequested, bidResponse...)
  const clonedEvent = deepClone(event);
  // Add event duration since auction start on event and add it to the cache
  clonedEvent.durationSinceAuctionStart = Date.now() - auctionStartTime;
  logInfo(`Caching event ${eventType}:`, clonedEvent);
  eventCache[eventType].push(clonedEvent);
}

var biddingEndpoints = {
  appnexus: '//ib.adnxs.com/ut/v3/prebid',
  criteo: '//bidder.criteo.com/cdb',
};
function getBidderCodeForUrl(url) {
  for (var bidder in biddingEndpoints) {
    const endpoint = biddingEndpoints[bidder];
    if (url.indexOf(endpoint) !== -1) {
      return bidder;
    }
  }
  return undefined;
}

function cachePerformanceEntriesEvents() {
  if (!window.performance || !window.performance.getEntries) {
    return;
  }

  const entries = window.performance.getEntries();
  const ret = {};
  for (let i = 0; i < entries.length; ++i) {
    const entry = entries[i];
    const bidder = getBidderCodeForUrl(entry.name);
    if (entry.duration && bidder) {
      if (!(bidder in ret)) {
        ret[bidder] = [];
      }
      ret[bidder].push(entry);
    }
  }

  eventCache[PERFORMANCE_ENTRIES_EVENT_TYPE] = ret;
}

function sendCachedEvents() {
  if (samplingPercentage <= Math.floor(Math.random() * 100)) {
    logInfo('Analytics not sent request sampled.');
    return;
  }

  const cachedEvents = eventCache;
  eventCache = {};
  logInfo(`Sending analytics events:`, cachedEvents);
  ajax(
    ANALYTICS_ENDPOINT,
    null,
    JSON.stringify(cachedEvents),
    {
      contentType: 'text/plain',
      method: 'POST',
      withCredentials: true
    }
  );
}

adaptermanager.registerAnalyticsAdapter({
  adapter: criteoAdapter,
  code: 'criteo'
});

export default criteoAdapter;
