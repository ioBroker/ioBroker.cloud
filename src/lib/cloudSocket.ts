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
 * Is it an address of ioBroker.pro, whatever protocol it names?
 *
 * @param url address of the cloud
 */
export function isProUrl(url: string): boolean {
    return /^(https|wss):\/\/iobroker\.pro:/i.test(url);
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

    if (getCloudProtocol(url) === 'socket.io-4') {
        return io(toHttpUrl(url), common);
    }
    return legacyIo(url, common);
}
