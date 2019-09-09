import { loadExternalScript } from '../src/adloader';
import { registerBidder } from '../src/adapters/bidderFactory';
import { config } from '../src/config';
import { BANNER, VIDEO } from '../src/mediaTypes';
import { parse } from '../src/url';
import * as utils from '../src/utils';
import find from 'core-js/library/fn/array/find';
import { ajax } from '../src/ajax';
import Promise from 'promise-polyfill/src/index';

export const ADAPTER_VERSION = 18;
const BIDDER_CODE = 'criteo';
const CDB_ENDPOINT = '//bidder.criteo.com/cdb';
const CRITEO_VENDOR_ID = 91;
const PROFILE_ID_INLINE = 207;
export const PROFILE_ID_PUBLISHERTAG = 185;

// Unminified source code can be found in: https://github.com/Prebid-org/prebid-js-external-js-criteo/blob/master/dist/prod.js
const PUBLISHER_TAG_URL = '//static.criteo.net/js/ld/publishertag.prebid.js';

export const FAST_BID_PUBKEY_IE11 = {
  kty: 'RSA',
  n: 'ztQYwCE5BU7T9CDM5he6rKoabstXRmkzx54zFPZkWbK530dwtLBDeaWBMxHBUT55CYyboR_EZ4efghPi3CoNGfGWezpjko9P6p2EwGArtHEeS4slhu_SpSIFMjG6fdrpRoNuIAMhq1Z-Pr_-HOd1pThFKeGFr2_NhtAg-TXAzaU',
  e: 'AQAB',
  alg: 'RS256'
};

export const FAST_BID_PUBKEY = Object.assign({}, FAST_BID_PUBKEY_IE11, { ext: 'true' });

/** @type {BidderSpec} */
export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [ BANNER, VIDEO ],

  /**
   * @param {object} bid
   * @return {boolean}
   */
  isBidRequestValid: (bid) => {
    // either one of zoneId or networkId should be set
    if (!(bid && bid.params && (bid.params.zoneId || bid.params.networkId))) {
      return false;
    }

    // video media types requires some mandatory params
    if (hasVideoMediaType(bid)) {
      if (!hasValidVideoMediaType(bid)) {
        return false;
      }
    }

    return true;
  },

  /**
   * @param {BidRequest[]} bidRequests
   * @param {*} bidderRequest
   * @return {ServerRequest}
   */
  buildRequests: (bidRequests, bidderRequest) => {
    let loadFastBidPromise = new Promise((resolve, reject) => resolve(false));
    let callCdbPromise = new Promise((resolve, reject) => resolve({}));

    Object.assign(bidderRequest, { ceh: config.getConfig('criteo.ceh') });

    // If publisher tag not already loaded try to get it from fast bid
    if (!publisherTagAvailable()) {
      window.Criteo = window.Criteo || {};
      window.Criteo.usePrebidEvents = false;

      loadFastBidPromise = tryGetCriteoFastBid() || loadFastBidPromise;

      // Reload the PublisherTag after the timeout to ensure FastBid is up-to-date and tracking done properly
      setTimeout(() => {
        loadExternalScript(PUBLISHER_TAG_URL, BIDDER_CODE);
      }, bidderRequest.timeout);
    } else {
      let cdbRequest = buildRequest(bidRequests, bidderRequest);
      return { method: 'POST', url: cdbRequest.url, data: cdbRequest.data, bidRequests };
    }

    callCdbPromise = loadFastBidPromise
      .then(_ => {
        let cdbRequest = buildRequest(bidRequests, bidderRequest);

        return new Promise(function (resolve, reject) {
          ajax(
            cdbRequest.url,
            {
              success: function(response, responseObj) {
                try {
                  response = JSON.parse(response);
                } catch (e) {
                  // Doesn't matter if not JSON, particularly, it will happen when we receive a 204
                }
                resolve({
                  body: response,
                  headers: {
                    get: responseObj.getResponseHeader.bind(responseObj),
                  },
                });
              },
              error: function(statusText, _) {
                reject(new Error(statusText));
              }
            },
            JSON.stringify(cdbRequest.data),
            {
              method: 'POST',
              contentType: 'text/plain',
              withCredentials: true
            }
          );
        });
      })
      .catch(error => {
        console.error('Unable to call criteo, error is', error);
      })
      .then(response => {
        return response;
      });

    return { method: 'PROMISE', promise: callCdbPromise, bidRequests };
  },

  /**
   * @param {*} response
   * @param {ServerRequest} request
   * @return {Bid[]}
   */
  interpretResponse: (response, request) => {
    const body = response !== undefined ? (response.body || response) : undefined;

    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(request);
      if (adapter) {
        return adapter.interpretResponse(body, request);
      }
    }

    const bids = [];

    if (body && body.slots && utils.isArray(body.slots)) {
      body.slots.forEach(slot => {
        const bidRequest = find(request.bidRequests, b => b.adUnitCode === slot.impid && (!b.params.zoneId || parseInt(b.params.zoneId) === slot.zoneid));
        const bidId = bidRequest.bidId;
        const bid = {
          requestId: bidId,
          adId: slot.bidId || utils.getUniqueIdentifierStr(),
          cpm: slot.cpm,
          currency: slot.currency,
          netRevenue: true,
          ttl: slot.ttl || 60,
          creativeId: bidId,
          width: slot.width,
          height: slot.height,
          dealId: slot.dealCode,
        }
        if (slot.native) {
          bid.ad = createNativeAd(bidId, slot.native, bidRequest.params.nativeCallback);
        } else if (slot.video) {
          bid.vastUrl = slot.displayurl;
          bid.mediaType = VIDEO;
        } else {
          bid.ad = slot.creative;
        }
        bids.push(bid);
      });
    }

    return bids;
  },

  /**
   * @param {TimedOutBid} timeoutData
   */
  onTimeout: (timeoutData) => {
    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(timeoutData.auctionId);
      adapter.handleBidTimeout();
    }
  },

  /**
   * @param {Bid} bid
   */
  onBidWon: (bid) => {
    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(bid.auctionId);
      adapter.handleBidWon(bid);
    }
  },

  /**
   * @param {Bid} bid
   */
  onSetTargeting: (bid) => {
    if (publisherTagAvailable()) {
      const adapter = Criteo.PubTag.Adapters.Prebid.GetAdapter(bid.auctionId);
      adapter.handleSetTargeting(bid);
    }
  },
};

/**
 * @return {boolean}
 */
function publisherTagAvailable() {
  return typeof Criteo !== 'undefined' && Criteo.PubTag && Criteo.PubTag.Adapters && Criteo.PubTag.Adapters.Prebid;
}

/**
 * @param {BidRequest[]} bidRequests
 * @return {CriteoContext}
 */
function buildContext(bidRequests) {
  const url = utils.getTopWindowUrl();
  const queryString = parse(url).search;

  const context = {
    url: url,
    debug: queryString['pbt_debug'] === '1',
    noLog: queryString['pbt_nolog'] === '1',
    amp: false,
  };

  bidRequests.forEach(bidRequest => {
    if (bidRequest.params.integrationMode === 'amp') {
      context.amp = true;
    }
  })

  return context;
}

/**
 * @param {CriteoContext} context
 * @return {string}
 */
function buildCdbUrl(context) {
  let url = CDB_ENDPOINT;
  url += '?profileId=' + PROFILE_ID_INLINE;
  url += '&av=' + String(ADAPTER_VERSION);
  url += '&wv=' + encodeURIComponent('$prebid.version$');
  url += '&cb=' + String(Math.floor(Math.random() * 99999999999));

  if (context.amp) {
    url += '&im=1';
  }
  if (context.debug) {
    url += '&debug=1';
  }
  if (context.noLog) {
    url += '&nolog=1';
  }

  return url;
}

function buildRequest(bidRequests, bidderRequest) {
  let url;
  let data;
  if (publisherTagAvailable()) {
    const adapter = new Criteo.PubTag.Adapters.Prebid(PROFILE_ID_PUBLISHERTAG, ADAPTER_VERSION, bidRequests, bidderRequest, '$prebid.version$');
    url = adapter.buildCdbUrl();
    data = adapter.buildCdbRequest();
  } else {
    const context = buildContext(bidRequests);
    url = buildCdbUrl(context);
    data = buildCdbRequest(context, bidRequests, bidderRequest);
  }
  return { url, data };
}

/**
 * @param {CriteoContext} context
 * @param {BidRequest[]} bidRequests
 * @return {*}
 */
function buildCdbRequest(context, bidRequests, bidderRequest) {
  let networkId;
  const request = {
    publisher: {
      url: context.url,
    },
    slots: bidRequests.map(bidRequest => {
      networkId = bidRequest.params.networkId || networkId;
      const slot = {
        impid: bidRequest.adUnitCode,
        transactionid: bidRequest.transactionId,
        auctionId: bidRequest.auctionId,
        sizes: getBannerSizes(bidRequest),
      };
      if (bidRequest.params.zoneId) {
        slot.zoneid = bidRequest.params.zoneId;
      }
      if (bidRequest.params.publisherSubId) {
        slot.publishersubid = bidRequest.params.publisherSubId;
      }
      if (bidRequest.params.nativeCallback) {
        slot.native = true;
      }
      if (hasVideoMediaType(bidRequest)) {
        const video = {
          playersizes: getVideoSizes(bidRequest),
          mimes: bidRequest.mediaTypes.video.mimes,
          protocols: bidRequest.mediaTypes.video.protocols,
          maxduration: bidRequest.mediaTypes.video.maxduration,
          api: bidRequest.mediaTypes.video.api
        }

        video.skip = bidRequest.params.video.skip;
        video.placement = bidRequest.params.video.placement;
        video.minduration = bidRequest.params.video.minduration;
        video.playbackmethod = bidRequest.params.video.playbackmethod;
        video.startdelay = bidRequest.params.video.startdelay;

        slot.video = video;
      }
      return slot;
    }),
  };
  if (networkId) {
    request.publisher.networkid = networkId;
  }
  request.user = {};
  if (bidderRequest && bidderRequest.ceh) {
    request.user.ceh = bidderRequest.ceh;
  }
  if (bidderRequest && bidderRequest.gdprConsent) {
    request.gdprConsent = {};
    if (typeof bidderRequest.gdprConsent.gdprApplies !== 'undefined') {
      request.gdprConsent.gdprApplies = !!(bidderRequest.gdprConsent.gdprApplies);
    }
    if (bidderRequest.gdprConsent.vendorData && bidderRequest.gdprConsent.vendorData.vendorConsents &&
      typeof bidderRequest.gdprConsent.vendorData.vendorConsents[ CRITEO_VENDOR_ID.toString(10) ] !== 'undefined') {
      request.gdprConsent.consentGiven = !!(bidderRequest.gdprConsent.vendorData.vendorConsents[ CRITEO_VENDOR_ID.toString(10) ]);
    }
    if (typeof bidderRequest.gdprConsent.consentString !== 'undefined') {
      request.gdprConsent.consentData = bidderRequest.gdprConsent.consentString;
    }
  }
  return request;
}

function getVideoSizes(bidRequest) {
  return parseSizes(utils.deepAccess(bidRequest, 'mediaTypes.video.playerSize'));
}

function getBannerSizes(bidRequest) {
  return parseSizes(utils.deepAccess(bidRequest, 'mediaTypes.banner.sizes') || bidRequest.sizes);
}

function parseSize(size) {
  return size[0] + 'x' + size[1];
}

function parseSizes(sizes) {
  if (Array.isArray(sizes[0])) { // is there several sizes ? (ie. [[728,90],[200,300]])
    return sizes.map(size => parseSize(size));
  }

  return [parseSize(sizes)]; // or a single one ? (ie. [728,90])
}

function hasVideoMediaType(bidRequest) {
  if (utils.deepAccess(bidRequest, 'params.video') === undefined) {
    return false;
  }
  return utils.deepAccess(bidRequest, 'mediaTypes.video') !== undefined;
}

function hasValidVideoMediaType(bidRequest) {
  let isValid = true;

  var requiredMediaTypesParams = ['mimes', 'playerSize', 'maxduration', 'protocols', 'api'];

  requiredMediaTypesParams.forEach(function(param) {
    if (utils.deepAccess(bidRequest, 'mediaTypes.video.' + param) === undefined) {
      isValid = false;
      utils.logError('Criteo Bid Adapter: mediaTypes.video.' + param + ' is required');
    }
  });

  var requiredParams = ['skip', 'placement', 'playbackmethod'];

  requiredParams.forEach(function(param) {
    if (utils.deepAccess(bidRequest, 'params.video.' + param) === undefined) {
      isValid = false;
      utils.logError('Criteo Bid Adapter: params.video.' + param + ' is required');
    }
  });

  if (isValid) {
    // We do not support long form for now, also we have to check that context & placement are consistent
    if (bidRequest.mediaTypes.video.context == 'instream' && bidRequest.params.video.placement === 1) {
      return true;
    } else if (bidRequest.mediaTypes.video.context == 'outstream' && bidRequest.params.video.placement !== 1) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} id
 * @param {*} payload
 * @param {*} callback
 * @return {string}
 */
function createNativeAd(id, payload, callback) {
  // Store the callback and payload in a global object to be later accessed from the creative
  window.criteo_prebid_native_slots = window.criteo_prebid_native_slots || {};
  window.criteo_prebid_native_slots[id] = { callback, payload };

  // The creative is in an iframe so we have to get the callback and payload
  // from the parent window (doesn't work with safeframes)
  return `<script type="text/javascript">
    var win = window;
    for (var i = 0; i < 10; ++i) {
      win = win.parent;
      if (win.criteo_prebid_native_slots) {
        var responseSlot = win.criteo_prebid_native_slots["${id}"];
        responseSlot.callback(responseSlot.payload);
        break;
      }
    }
  </script>`;
}

export function str2ab(str) {
  var buf = new ArrayBuffer(str.length);
  var bufView = new Uint8Array(buf);
  for (var i = 0; i < str.length; ++i) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

/**
 * Verify fastBid with cryto.subtle
 * @param {string} hash
 * @param {string} code
 * @returns Promise<boolean> if fastbid is valid
 */
function cryptoVerifyAsync(hash, code) {
  // Standard
  var standardSubtle = window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle);
  var algo = { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } };
  if (standardSubtle) {
    return standardSubtle.importKey('jwk', FAST_BID_PUBKEY, algo, false, ['verify']).then(
      function (cryptoKey) {
        return standardSubtle.verify(algo, cryptoKey, str2ab(atob(hash)), str2ab(code));
      }
    );
  }

  // IE11
  if (window.msCrypto) {
    return new Promise(function (resolve, reject) {
      try {
        var eImport = window.msCrypto.subtle.importKey('jwk', str2ab(JSON.stringify(FAST_BID_PUBKEY_IE11)), algo, false, ['verify']);
        eImport.onerror = function (evt) { reject(evt) };
        eImport.oncomplete = function (evtKey) {
          var cryptoKey = evtKey.target.result;
          var eVerify = window.msCrypto.subtle.verify(algo, cryptoKey, str2ab(atob(hash)), str2ab(code));
          eVerify.onerror = function (evt) { reject(evt); };
          eVerify.oncomplete = function (evt) { resolve(evt.target.result); };
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  // cypto not available, return undefined
}

/**
 * check if fastbid is valid
 * @param {string} publisherTagHash
 * @param {string} publisherTag
 * @returns {Promise<boolean>} if fastBid is valid, undefined if error
 */
function validateFastBid(publisherTagHash, publisherTag) {
  // Verify the hash using cryptography
  try {
    return cryptoVerifyAsync(publisherTagHash, publisherTag);
  } catch (e) {
    utils.logWarn('Failed to verify Criteo FastBid');
    return undefined;
  }
}
/**
 * @return {Promise<boolean>}
 */
export function tryGetCriteoFastBid() {
  try {
    const fastBidStorageKey = 'criteo_fast_bid';
    const hashPrefix = '// Hash: ';
    const fastBidFromStorage = localStorage.getItem(fastBidStorageKey);

    if (fastBidFromStorage !== null) {
      // The value stored must contain the file's encrypted hash as first line
      const firstLineEndPosition = fastBidFromStorage.indexOf('\n');
      const firstLine = fastBidFromStorage.substr(0, firstLineEndPosition).trim();

      if (firstLine.substr(0, hashPrefix.length) !== hashPrefix) {
        utils.logWarn('No hash found in FastBid');
        localStorage.removeItem(fastBidStorageKey);
      } else {
        // Remove the hash part from the locally stored value
        const publisherTagHash = firstLine.substr(hashPrefix.length);
        const publisherTag = fastBidFromStorage.substr(firstLineEndPosition + 1);

        // check if fastBid is valid
        const p = validateFastBid(publisherTagHash, publisherTag);
        if (p !== undefined) {
          return p.then((isValid) => {
            if (isValid) {
              utils.logInfo('Using Criteo FastBid');
              eval(publisherTag); // eslint-disable-line no-eval
            } else {
              utils.logWarn('Invalid Criteo FastBid found');
              localStorage.removeItem(fastBidStorageKey);
            }
            return isValid;
          }).catch(error => {
            utils.logWarn('catch validateFastBid error is', error);
            localStorage.removeItem(fastBidStorageKey);
          });
        }
      }
    }
  } catch (e) {
    // Unable to get fast bid
  }
}

registerBidder(spec);
