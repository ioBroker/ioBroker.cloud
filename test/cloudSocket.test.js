'use strict';
/**
 * The choice of the protocol by the address of the cloud, and a real connection with socket.io 4.
 *
 * socket.io 1.7 is what every installation uses today; it is not tested here against a server, because its server
 * would bring the old dependencies into the project. socket.io 4 is tested against a real server: what the adapter
 * relies on - answers (acks) in both directions, binary data, removing all listeners - has to work as with 1.7.
 *
 * Needs a build first: `npm run build` (or `tsc -p tsconfig.build.json`).
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const {
    createCloudSocket,
    getCloudProtocol,
    isProUrl,
    toHttpUrl,
    LEGACY_URL_NET,
    LEGACY_URL_PRO,
} = require('../build/lib/cloudSocket');

const OPTIONS = { reconnection: false, rejectUnauthorized: true, timeout: 5000 };

/**
 * @param emitter what emits the event
 * @param event the name of the event
 */
const once = (emitter, event) => new Promise(resolve => emitter.on(event, (...args) => resolve(args)));

/**
 * Emits from the server and resolves with all arguments of the answer
 *
 * @param socket the socket on the server
 * @param args event and its arguments
 */
const ask = (socket, ...args) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer')), 2000);
        socket.emit(...args, (...answer) => {
            clearTimeout(timer);
            resolve(answer);
        });
    });

describe('cloudSocket: the protocol by the address', () => {
    it('keeps socket.io 1.7 for http and https', () => {
        assert.equal(getCloudProtocol('https://iobroker.pro:10555'), 'socket.io-1');
        assert.equal(getCloudProtocol('http://localhost:10555'), 'socket.io-1');
        assert.equal(getCloudProtocol(LEGACY_URL_NET), 'socket.io-1');
        assert.equal(getCloudProtocol(LEGACY_URL_PRO), 'socket.io-1');
    });

    it('takes socket.io 4 for ws and wss, whatever the case', () => {
        assert.equal(getCloudProtocol('wss://iobroker.pro:10556'), 'socket.io-4');
        assert.equal(getCloudProtocol('ws://localhost:10556'), 'socket.io-4');
        assert.equal(getCloudProtocol('WSS://iobroker.pro:10556'), 'socket.io-4');
    });

    it('turns ws and wss into http and https', () => {
        assert.equal(toHttpUrl('wss://iobroker.pro:10556'), 'https://iobroker.pro:10556');
        assert.equal(toHttpUrl('ws://localhost:10556'), 'http://localhost:10556');
        assert.equal(toHttpUrl('https://iobroker.pro:10555'), 'https://iobroker.pro:10555');
    });

    it('knows the addresses of ioBroker.pro', () => {
        assert.equal(isProUrl('https://iobroker.pro:10555'), true);
        assert.equal(isProUrl('wss://iobroker.pro:10556'), true);
        assert.equal(isProUrl('https://iobroker.net:10555'), false);
        assert.equal(isProUrl('wss://iobroker.net:10556'), false);
        // as before: without a port it is not taken as the address of pro
        assert.equal(isProUrl('https://iobroker.pro'), false);
        assert.equal(isProUrl('https://iobroker.pro.example.com:10555'), false);
    });
});

describe('cloudSocket: socket.io 4 against a real server', () => {
    let httpServer;
    let server;
    let url;
    let client;

    beforeEach(async () => {
        httpServer = http.createServer();
        server = new Server(httpServer, { transports: ['websocket'] });
        await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
        url = `ws://127.0.0.1:${httpServer.address().port}`;
    });

    afterEach(async () => {
        client?.disconnect();
        client = null;
        await new Promise(resolve => server.close(() => resolve()));
    });

    it('connects with a ws:// address', async () => {
        const connected = once(server, 'connection');
        client = createCloudSocket(url, OPTIONS);
        await once(client, 'connect');
        await connected;
        assert.equal(client.connected, true);
    });

    it('answers the server through the callback of an event', async () => {
        const connected = once(server, 'connection');
        client = createCloudSocket(url, OPTIONS);
        const [serverSocket] = await connected;

        client.on('mc', (socketId, command, id, callback) => callback(null, { socketId, command, id }));
        const answer = await ask(serverSocket, 'mc', 'browser1', 'getState', 'a.0.b');

        assert.deepEqual(answer, [null, { socketId: 'browser1', command: 'getState', id: 'a.0.b' }]);
    });

    it('gets the answer of the server to its own event', async () => {
        server.on('connection', socket =>
            socket.on('apikey', (key, version, uuid, callback) => callback(null, { validTill: 1, key })),
        );
        client = createCloudSocket(url, OPTIONS);

        const answer = await new Promise(resolve =>
            client.emit('apikey', '@pro_key', '6.4.0', 'uuid', (...args) => resolve(args)),
        );
        assert.deepEqual(answer, [null, { validTill: 1, key: '@pro_key' }]);
    });

    it('hands binary data over as it is', async () => {
        const connected = once(server, 'connection');
        client = createCloudSocket(url, OPTIONS);
        const [serverSocket] = await connected;
        const body = Buffer.from([0, 1, 2, 253, 254, 255]);

        client.on('html', (path, callback) => callback(null, 200, { 'content-type': 'image/png' }, body));
        const [error, status, headers, received] = await ask(serverSocket, 'html', '/a.png');

        assert.equal(error, null);
        assert.equal(status, 200);
        assert.deepEqual(headers, { 'content-type': 'image/png' });
        assert.ok(Buffer.isBuffer(received));
        assert.deepEqual(received, body);
    });

    it('removes all listeners with off() without arguments', async () => {
        const connected = once(server, 'connection');
        client = createCloudSocket(url, OPTIONS);
        const [serverSocket] = await connected;
        await once(client, 'connect');

        let calls = 0;
        client.on('pongg', () => calls++);
        client.off();
        serverSocket.emit('pongg');
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.equal(calls, 0);
    });

    it('reports a cloud it cannot reach as connect_error', async () => {
        // a port nobody listens on
        const unused = http.createServer();
        await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
        const port = unused.address().port;
        await new Promise(resolve => unused.close(resolve));
        client = createCloudSocket(`ws://127.0.0.1:${port}`, OPTIONS);

        const [error] = await once(client, 'connect_error');
        assert.ok(error);
        assert.equal(client.connected, false);
    });
});
