"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PONG_TIMEOUT = exports.SLOWEST_UPLOAD = exports.LEGACY_URL_NET = exports.LEGACY_URL_PRO = void 0;
exports.getCloudProtocol = getCloudProtocol;
exports.toHttpUrl = toHttpUrl;
exports.isProUrl = isProUrl;
exports.createCloudSocket = createCloudSocket;
exports.sentBytes = sentBytes;
exports.pongTimeout = pongTimeout;
const socket_io_client_legacy_1 = __importDefault(require("socket.io-client-legacy"));
const socket_io_client_1 = require("socket.io-client");
/** The address of the cloud of today, the one to go back to if socket.io 4 cannot be reached */
exports.LEGACY_URL_PRO = 'https://iobroker.pro:10555';
exports.LEGACY_URL_NET = 'https://iobroker.net:10555';
/**
 * The protocol of an address
 *
 * @param url address of the cloud
 */
function getCloudProtocol(url) {
    return /^wss?:\/\//i.test(url) ? 'socket.io-4' : 'socket.io-1';
}
/**
 * The address with `http(s)://` - what socket.io and the HTTP services of the cloud (e.g. Polly) expect
 *
 * @param url address of the cloud
 */
function toHttpUrl(url) {
    return url.replace(/^ws(s?):\/\//i, 'http$1://');
}
/**
 * Is it an address of ioBroker.pro? It only has to contain "iobroker.pro", whatever protocol and port it names
 *
 * @param url address of the cloud
 */
function isProUrl(url) {
    return url.toLowerCase().includes('iobroker.pro');
}
/**
 * Connects with the protocol the address names.
 *
 * @param url address of the cloud
 * @param options how to connect
 */
function createCloudSocket(url, options) {
    const common = {
        transports: ['websocket'],
        autoConnect: true,
        reconnection: options.reconnection,
        rejectUnauthorized: options.rejectUnauthorized,
        randomizationFactor: 0.9,
        reconnectionDelay: 60000,
        reconnectionDelayMax: 120000,
        timeout: options.timeout,
    };
    const socket = getCloudProtocol(url) === 'socket.io-4' ? (0, socket_io_client_1.io)(toHttpUrl(url), common) : (0, socket_io_client_legacy_1.default)(url, common);
    countSent(socket.io);
    return socket;
}
/** The bytes a manager of socket.io has sent, over all its connections */
const sentByManager = new WeakMap();
/**
 * Counts what goes out: every packet of engine.io (`packetCreate`, both clients). The manager has a new engine with
 * every connection; a manager that is used again is not counted twice.
 *
 * @param manager `io` of the socket
 */
function countSent(manager) {
    if (!manager?.on || sentByManager.has(manager)) {
        return;
    }
    const counter = { bytes: 0 };
    sentByManager.set(manager, counter);
    manager.on('open', () => manager.engine?.on('packetCreate', (packet) => {
        const data = packet?.data;
        // a string by its length is near enough: JSON is mostly ASCII
        counter.bytes +=
            typeof data === 'string' ? data.length : data?.byteLength || 0;
    }));
}
/**
 * The bytes the socket has sent so far: its packets, as they went to the WebSocket. Only the difference between
 * two calls tells something.
 *
 * @param socket socket of either client
 */
function sentBytes(socket) {
    return sentByManager.get(socket?.io)?.bytes || 0;
}
/** The slowest upload the pong is waited for: 1 Mbit/s */
exports.SLOWEST_UPLOAD = 128 * 1024;
/** Longer the cloud does not wait for the pong of engine.io either (ping interval 50 s + ping timeout 110 s) */
exports.MAX_PONG_TIMEOUT = 160_000;
/**
 * How long to wait for the pong of the cloud to a ping.
 *
 * The ping goes out behind all the adapter has sent before. A big answer takes long on a slow upload (all objects
 * for vis-2: 30 MB, 20 s with 12 Mbit/s): its pong would come too late, the adapter would disconnect for nothing -
 * and send it all again. So the ping timeout is longer by what was sent since the last pong, as fast as the slowest
 * upload. How much of it is still on its way cannot be told: on Windows the system takes it all at once.
 *
 * @param pingTimeout the ping timeout of the settings in ms
 * @param sentSinceLastPong bytes sent since the ping that got the last pong
 */
function pongTimeout(pingTimeout, sentSinceLastPong) {
    const upload = Math.ceil((Math.max(0, sentSinceLastPong) / exports.SLOWEST_UPLOAD) * 1000);
    return Math.max(pingTimeout, Math.min(exports.MAX_PONG_TIMEOUT, pingTimeout + upload));
}
//# sourceMappingURL=cloudSocket.js.map