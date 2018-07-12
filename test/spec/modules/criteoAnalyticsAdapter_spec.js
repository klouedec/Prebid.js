import criteoAnalyticsAdapter from 'modules/criteoAnalyticsAdapter';
import {expect} from 'chai';

let events = require('src/events');
let constants = require('src/constants.json');

describe('CriteoAnalyticsAdapter', function () {

    let xhr;
    let requests;

    beforeEach(() => {
        // Mock xml http request
        requests = [];
        xhr = sinon.useFakeXMLHttpRequest();
        xhr.onCreate = request => requests.push(request);
        // Mock prebid events
        sinon.stub(events, 'getEvents').returns([]);
        // Mock Date.now to have a static date
        sinon.stub(Date, 'now').returns(2);
        // Enable analytics adapter
        criteoAnalyticsAdapter.enableAnalytics({
            provider: 'criteo',
            options: {
                sendDelay: 0 // Use 0 delay for tests
            }
        });
    });

    afterEach(() => {
        // Disable analytics adapter
        criteoAnalyticsAdapter.disableAnalytics();
        // Remove mocks
        xhr.restore();
        events.getEvents.restore();
        Date.now.restore();
    });

    it('send events to endpoint after auction end event', function (done) {
        events.emit(constants.EVENTS.AUCTION_END, { aField: 'aFieldValue' });
        events.emit(constants.EVENTS.BID_TIMEOUT, { aTimeoutField: 'aTimeoutFieldValue' });

        // Assert using a setTimeout as events are sent with a delay
        setTimeout(() => {
            expect(requests.length).to.equal(1);
            expect(requests[0].url).to.equal('http://bidder.criteo.com/prebidAnalytics');
            expect(requests[0].method).to.equal('POST');
            expect(requests[0].requestBody.auctionEnd).to.deep.equal([ { aField: 'aFieldValue', durationSinceAuctionStart: 2 } ]);
            expect(requests[0].requestBody.bidTimeout).to.deep.equal([ { aTimeoutField: 'aTimeoutFieldValue', durationSinceAuctionStart: 2 } ]);
            done();
        }, 0)
    });

    it('adds duration relative to auction init timestamp on events', function (done) {
        events.emit(constants.EVENTS.AUCTION_INIT, { timestamp: 1 } );
        events.emit(constants.EVENTS.AUCTION_END, { aField: 'aFieldValue' });

        // Assert using a setTimeout as events are sent with a delay
        setTimeout(() => {
            expect(requests.length).to.equal(1);
            expect(requests[0].requestBody.auctionInit).to.deep.equal([ { timestamp: 1, config: { sendDelay: 0 }, durationSinceAuctionStart: 1 } ]);
            expect(requests[0].requestBody.auctionEnd).to.deep.equal([ { aField: 'aFieldValue', durationSinceAuctionStart: 1 } ]);
            done();
        }, 0)
    });

    it('send performance entries events', function (done) {
        sinon.stub(window.performance, 'getEntries').returns([ { duration: 0 } ]);
        events.emit(constants.EVENTS.AUCTION_END, { aField: 'aFieldValue' });

        // Assert using a setTimeout as events are sent with a delay
        setTimeout(() => {
            expect(requests.length).to.equal(1);
            expect(requests[0].requestBody.performanceEntries).to.deep.equal([ { duration: 0 } ]);
            window.performance.getEntries.restore;
            done();
        }, 0)
    });
});
