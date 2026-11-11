import legacyIo from 'socket.io-client-legacy';
import { io } from 'socket.io-client';

/**
 * The protocol the cloud speaks under an address.
 *
 * Every adapter in the field connects with socket.io 1.7, so the cloud keeps speaking it under `https://`. A cloud
 * with socket.io 4 is named with `wss://` (or `ws://`): the scheme tells the protocol, so a redirect of the cloud
 * only has to name the address. The cloud redirects by the version of the adapter, so an adapter that knows only
 * socket.io 1.7 is never sent there.
 */
export type CloudProtocol = 'socket.io-1' | 'socket.io-4';

/** The two clients share everything the adapter uses */
export interface CloudSocket {
    readonly connected: boolean;
    on(event: string, listener: (...args: any[]) => void): CloudSocket;
    /** Without arguments, it removes all listeners */
    off(event?: string, listener?: (...args: any[]) => void): CloudSocket;
    emit(event: string, ...args: any[]): CloudSocket;
    disconnect(): CloudSocket;
    close(): CloudSocket;
}

export interface CloudSocketOptions {
    /** Let socket.io reconnect by itself */
    reconnection: boolean;
    rejectUnauthorized: boolean;
    /** Connection timeout in ms */
    timeout: number;
}

/** The address of the cloud of today, the one to go back to if socket.io 4 cannot be reached */
export const LEGACY_URL_PRO = 'https://iobroker.pro:10555';
export const LEGACY_URL_NET = 'https://iobroker.net:10555';

/**
 * The protocol of an address
 *
 * @param url address of the cloud
 */
export function getCloudProtocol(url: string): CloudProtocol {
    return /^wss?:\/\//i.test(url) ? 'socket.io-4' : 'socket.io-1';
}

/**
 * The address with `http(s)://` - what socket.io and the HTTP services of the cloud (e.g. Polly) expect
 *
 * @param url address of the cloud
 */
export function toHttpUrl(url: string): string {
    return url.replace(/^ws(s?):\/\//i, 'http$1://');
}

/**
 * Is it an address of ioBroker.pro? It only has to contain "iobroker.pro", whatever protocol and port it names
 *
 * @param url address of the cloud
 */
export function isProUrl(url: string): boolean {
    return url.toLowerCase().includes('iobroker.pro');
}

/**
 * Connects with the protocol the address names.
 *
 * @param url address of the cloud
 * @param options how to connect
 */
export function createCloudSocket(url: string, options: CloudSocketOptions): CloudSocket {
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

    const socket: CloudSocket =
        getCloudProtocol(url) === 'socket.io-4' ? io(toHttpUrl(url), common) : legacyIo(url, common);
    countSent((socket as any).io);
    return socket;
}

/** The bytes a manager of socket.io has sent, over all its connections */
const sentByManager = new WeakMap<object, { bytes: number }>();

/**
 * Counts what goes out: every packet of engine.io (`packetCreate`, both clients). The manager has a new engine with
 * every connection; a manager that is used again is not counted twice.
 *
 * @param manager `io` of the socket
 */
function countSent(manager: any): void {
    if (!manager?.on || sentByManager.has(manager)) {
        return;
    }
    const counter = { bytes: 0 };
    sentByManager.set(manager, counter);
    manager.on('open', () =>
        manager.engine?.on('packetCreate', (packet: { data?: unknown }) => {
            const data = packet?.data;
            // a string by its length is near enough: JSON is mostly ASCII
            counter.bytes +=
                typeof data === 'string' ? data.length : (data as ArrayBuffer | undefined)?.byteLength || 0;
        }),
    );
}

/**
 * The bytes the socket has sent so far: its packets, as they went to the WebSocket. Only the difference between
 * two calls tells something.
 *
 * @param socket socket of either client
 */
export function sentBytes(socket: CloudSocket | null | undefined): number {
    return sentByManager.get((socket as any)?.io)?.bytes || 0;
}

/** The slowest upload the pong is waited for: 1 Mbit/s */
export const SLOWEST_UPLOAD = 128 * 1024;
/** Longer the cloud does not wait for the pong of engine.io either (ping interval 50 s + ping timeout 110 s) */
export const MAX_PONG_TIMEOUT = 160_000;

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
export function pongTimeout(pingTimeout: number, sentSinceLastPong: number): number {
    const upload = Math.ceil((Math.max(0, sentSinceLastPong) / SLOWEST_UPLOAD) * 1000);
    return Math.max(pingTimeout, Math.min(MAX_PONG_TIMEOUT, pingTimeout + upload));
}
