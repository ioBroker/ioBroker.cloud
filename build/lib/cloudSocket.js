"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_URL_NET = exports.LEGACY_URL_PRO = void 0;
exports.getCloudProtocol = getCloudProtocol;
exports.toHttpUrl = toHttpUrl;
exports.isProUrl = isProUrl;
exports.createCloudSocket = createCloudSocket;
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
    if (getCloudProtocol(url) === 'socket.io-4') {
        return (0, socket_io_client_1.io)(toHttpUrl(url), common);
    }
    return (0, socket_io_client_legacy_1.default)(url, common);
}
//# sourceMappingURL=cloudSocket.js.map