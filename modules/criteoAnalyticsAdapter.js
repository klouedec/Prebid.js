import {ajax} from 'src/ajax';
import adapter from 'src/AnalyticsAdapter';
import CONSTANTS from 'src/constants.json';
import adaptermanager from 'src/adaptermanager';
import {logInfo} from 'src/utils';

const {
    EVENTS: {
        AUCTION_INIT,
        AUCTION_END
    }
} = CONSTANTS;

const ANALYTICS_ENDPOINT = 'http://bidder.criteo.com/prebid/analytics';
const DEFAULT_SEND_DELAY = 3000;
const PERFORMANCE_ENTRIES_EVENT_TYPE = 'performanceEntries';

let auctionStartTime = 0;
let eventCache = {};
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
  sendDelay = config.options && typeof config.options.sendDelay === 'number' ? config.options.sendDelay : DEFAULT_SEND_DELAY;
  criteoAdapter.originEnableAnalytics(config);  // call the base function
};

function initAuctionStartTime(actionInitEvent) {
    auctionStartTime = actionInitEvent.timestamp || Date.now();
}

function cacheEvent(eventType, event) {
    // Init event cache for this event type if required
    if (!eventCache[eventType]) {
        eventCache[eventType] = [];
    }

    // Add event duration since auction start on event and add it to the cache
    event.durationSinceAuctionStart = Date.now() - auctionStartTime;
    logInfo(`Caching event ${eventType}:`, event);
    eventCache[eventType].push(event);
}

function cachePerformanceEntriesEvents() {
    if (!window.performance || !window.performance.getEntries) {
        return;
    }
    eventCache[PERFORMANCE_ENTRIES_EVENT_TYPE] = window.performance.getEntries();
}

function sendCachedEvents() {
    const cachedEvents = eventCache;
    eventCache = {};
    logInfo(`Sending analytics events:`, cachedEvents);
    ajax(
        ANALYTICS_ENDPOINT,
        null,
        cachedEvents,
        {
          contentType: 'application/json'
        }
    );
}

adaptermanager.registerAnalyticsAdapter({
  adapter: criteoAdapter,
  code: 'criteo'
});

export default criteoAdapter;
