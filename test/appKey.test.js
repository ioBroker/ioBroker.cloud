'use strict';
/**
 * Unit tests for when the adapter asks again for its app-key. On a lost network the request ended with ETIMEDOUT,
 * the adapter gave up in its ready handler and stayed alive without a connection to the cloud. Every failure that
 * waiting can heal - no answer at all, or a 5xx of the proxy - must lead to a retry, a wrong login must not.
 * Real requests with axios against local servers.
 *
 * Needs a build first: `npm run build` (or `tsc -p tsconfig.build.json`).
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const axios = require('axios');
const { isTemporaryError, appKeyRetryDelay, failureReason } = require('../build/lib/appKey');

/** What axios rejects with for a request to this address */
async function failureOf(url, options = {}) {
    try {
        await axios.get(url, { validateStatus: status => status < 400, ...options });
    } catch (error) {
        return error;
    }
    throw new Error(`${url} did not fail`);
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('app-key: when to ask again', () => {
    const servers = [];
    after(() => servers.forEach(server => server.close()));

    it('asks again if the server does not answer in time (the lost network of vitanova)', async () => {
        // takes the connection, never answers
        const sockets = [];
        const silent = net.createServer(socket => sockets.push(socket));
        servers.push(silent);
        const port = await listen(silent);
        const error = await failureOf(`http://127.0.0.1:${port}/api/v1/appkeys`, { timeout: 200 });
        sockets.forEach(socket => socket.destroy());
        assert.equal(error.code, 'ECONNABORTED');
        assert.equal(isTemporaryError(error), true);
    });

    it('asks again if nobody listens', async () => {
        const closed = net.createServer();
        const port = await listen(closed);
        await new Promise(resolve => closed.close(resolve));
        const error = await failureOf(`http://127.0.0.1:${port}/api/v1/appkeys`);
        assert.equal(error.code, 'ECONNREFUSED');
        assert.equal(isTemporaryError(error), true);
    });

    it('asks again if the connection is reset', async () => {
        const resetting = net.createServer(socket => socket.resetAndDestroy());
        servers.push(resetting);
        const port = await listen(resetting);
        const error = await failureOf(`http://127.0.0.1:${port}/api/v1/appkeys`);
        assert.equal(isTemporaryError(error), true);
    });

    it('asks again if the proxy says the server behind it is down (502)', async () => {
        const proxy = http.createServer((req, res) => res.writeHead(502).end('<html>Bad Gateway</html>'));
        servers.push(proxy);
        const port = await listen(proxy);
        const error = await failureOf(`http://127.0.0.1:${port}/api/v1/appkeys`);
        assert.equal(failureReason(error), 'HTTP 502');
        assert.equal(isTemporaryError(error), true);
    });

    it('does not ask again for a wrong login (401)', async () => {
        const server = http.createServer((req, res) => res.writeHead(401).end());
        servers.push(server);
        const port = await listen(server);
        const error = await failureOf(`http://127.0.0.1:${port}/api/v1/appkeys`);
        assert.equal(isTemporaryError(error), false);
    });

    it('does not ask again for an error of its own code', () => {
        assert.equal(isTemporaryError(new TypeError('x is undefined')), false);
    });

    it('waits 10 seconds, then twice as long each time, at most 5 minutes', () => {
        assert.deepEqual(
            [0, 1, 2, 3, 4, 5, 6, 100].map(appKeyRetryDelay),
            [10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000],
        );
    });
});
