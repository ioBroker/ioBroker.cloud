import EventEmitter from 'node:events';
import WebSocket from 'ws'; // used for lovelace
import { SocketAdmin, type SocketSettings } from '@iobroker/socket-classes';
import type { Socket as SocketClient } from '@iobroker/ws-server';
import type { AddressInfo } from 'node:net';

process.on('uncaughtException', (err: Error): void => {
    // Handle the error safely
    console.error(err);
});

// From settings used only secure, auth and crossDomain
export default class SocketCloud extends SocketAdmin {
    public events: EventEmitter = new EventEmitter();
    private readonly lovelaceSockets: {
        [socketId: string]: {
            socket: null | WebSocket;
            connected: boolean;
            messages: string[] | null;
        };
    } = {};
    private readonly lovelaceServer: string | null;
    declare settings: SocketSettings & { version: string; apikey: string; uuid: string };

    constructor(
        socket: SocketClient,
        settings: SocketSettings & { version: string; apikey: string; uuid: string },
        adapter: ioBroker.Adapter,
        lovelaceServer?: string | null,
    ) {
        super(settings, adapter);
        this.lovelaceSockets = {};
        this.lovelaceServer = lovelaceServer || null;
        this.events = new EventEmitter();

        socket._apiKeyOk = false;

        this.addEventHandler('disconnect', socket => {
            (socket as any)._apiKeyOk = false;
            this.events.emit('disconnect');
        });

        this.initCommandsCloud();

        this.start(socket);

        // install handlers on socket
        this._initSocket(socket);
    }

    __getClientAddress(_socket: SocketClient): AddressInfo {
        // not used, just satisfy compiler
        return {
            address: 'cloud',
            family: 'IPv4',
            port: 0,
        };
    }

    // update session ID, but not ofter than 60 seconds
    __updateSession(socket: SocketClient): boolean {
        // if it is sub-socket => get the main socket
        if (socket?.___socket) {
            socket = socket.___socket;
        }

        if (socket._sessionID) {
            const time = Date.now();
            if (socket._lastActivity && time - socket._lastActivity > this.settings.ttl! * 1000) {
                socket.emit('reauthenticate');
                socket.disconnect();
                return false;
            }

            socket._lastActivity = time;

            if (!socket._sessionTimer) {
                socket._sessionTimer = setTimeout(() => {
                    socket._sessionTimer = undefined;
                    if (socket._sessionID) {
                        this.store?.get(socket._sessionID, (err, obj) => {
                            if (obj) {
                                void this.adapter.setSession(socket._sessionID!, this.settings.ttl!, obj);
                            } else {
                                socket.emit('reauthenticate');
                                socket.disconnect();
                            }
                        });
                    } else {
                        socket.emit('reauthenticate');
                        socket.disconnect();
                    }
                }, 60000);
            }
        }

        return true;
    }

    initCommandsCloud(): void {
        this.addCommandHandler('connect', socket => {
            socket._subSockets = {};
            this.adapter.log.debug('Connected. Check api key...');
            socket._apiKeyOk = false;

            // send api key if exists
            socket.emit(
                'apikey',
                this.settings.apikey,
                this.settings.version,
                this.settings.uuid,
                (
                    err: string | null | undefined,
                    instructions:
                        | { command: 'redirect'; url: string; notSave: boolean }
                        | { command: 'stop'; reason: string }
                        | { command: 'wait'; delaySeconds: number }
                        | { validTill?: number }
                        | number,
                ): void => {
                    // instructions = {
                    //     validTill: '2018-03-14T01:01:01.567Z',
                    //     command: 'wait' | 'stop' | 'redirect'
                    //     delaySeconds: seconds for wait
                    //     reason: Description of command
                    //     url: redirect URL
                    //     notSave: true | false for url. Save it or just use it

                    if (instructions) {
                        if (typeof instructions !== 'object') {
                            void this.adapter.setState('info.remoteTill', new Date(instructions).toISOString(), true);
                        } else {
                            if ((instructions as { validTill: number }).validTill) {
                                void this.adapter.setState(
                                    'info.remoteTill',
                                    new Date((instructions as { validTill: number }).validTill).toISOString(),
                                    true,
                                );
                            }

                            if ((instructions as { command: 'stop'; reason: string }).command === 'stop') {
                                this.stopAdapter(instructions as { command: 'stop'; reason: string });
                                return;
                            } else if (
                                (instructions as { command: 'redirect'; url: string; notSave: boolean }).command ===
                                'redirect'
                            ) {
                                this.redirectAdapter(
                                    instructions as { command: 'redirect'; url: string; notSave: boolean },
                                );
                                return;
                            } else if ((instructions as { command: 'wait'; delaySeconds: number }).command === 'wait') {
                                this.waitForConnect(instructions as { command: 'wait'; delaySeconds: number });
                                return;
                            }
                        }
                    }

                    if (!err) {
                        this.adapter.log.debug('API KEY OK');
                        socket._apiKeyOk = true;

                        this.events.emit('connect');
                    } else {
                        if (err.includes('Please buy remote access to use pro.')) {
                            this.stopAdapter({ reason: 'Please buy remote access to use pro.' });
                        }
                        this.adapter.log.error(err);
                        socket.close(); // disconnect
                    }
                },
            );
        });

        // remove standard error handler
        this.addCommandHandler('error');

        this.addCommandHandler('cloudDisconnect', (socket, socketId: string, err: string | undefined): void => {
            // if it is sub-socket => get the main socket (should never happen)
            if (socket?.___socket) {
                throw new Error('This should never happen!');
            }

            if (err) {
                this.adapter.log.warn(`User disconnected from cloud: ${socketId} ${err}`);
            }

            if (socket._subSockets && socketId) {
                if (socket._subSockets[socketId]) {
                    this.unsubscribeSocket(socket._subSockets[socketId]);
                    if (socket._subSockets[socketId]) {
                        delete socket._subSockets[socketId];
                    }
                } else {
                    this.adapter.log.warn(`Received disconnection for non-existing socketId: ${socketId}`);
                }
            } else {
                this.unsubscribeSocket(socket);

                // unsubscribe all sub-sockets, because a client does not use a multi-client
                if (socket._subSockets) {
                    Object.keys(socket._subSockets).forEach(socketId => {
                        this.unsubscribeSocket(socket._subSockets![socketId]);
                        if (socket._subSockets?.[socketId]) {
                            delete socket._subSockets[socketId];
                        }
                    });

                    delete socket._subSockets;
                }
            }

            if (this.adapter.log.level === 'debug') {
                this.commands!._showSubscribes(socket, 'fileChange');
            }

            this.events.emit('cloudDisconnect', socketId, socket._name);
        });

        this.addCommandHandler('cloudVersion', (socket, apiVersion) => {
            // if it is sub-socket => get the main socket (should never happen)
            if (socket?.___socket) {
                throw new Error('This should never happen!');
            }
            this.adapter.log.debug(`Cloud version: ${apiVersion}`);
            if (socket) {
                socket.__apiVersion = apiVersion;
            }
        });

        this.addCommandHandler('cloudConnect', (socket, socketId: string): void => {
            if (!socket.___socket) {
                socket._subSockets = socket._subSockets || {};
                socket._subSockets[socketId] = socket._subSockets[socketId] || {
                    id: socketId,
                    ___socket: socket, // store the main socket under ___socket
                    _acl: socket._acl,
                };
            }

            // do not auto-subscribe. The client must resubscribe all states anew
            this.events.emit('cloudConnect', socketId);
        });

        this.addCommandHandler('cloudCommand', (socket, cmd, data) => {
            if (cmd === 'stop') {
                this.stopAdapter(data);
            } else if (cmd === 'redirect') {
                this.redirectAdapter(data);
            } else if (cmd === 'wait') {
                this.waitForConnect(data);
            } else if (cmd === 'log') {
                this.adapter.log.warn(data);
            } else {
                this.adapter.log.warn(`Received unknown command "${cmd}" from server`);
            }
        });

        // restore WEB version of a written file (without base64)
        this.addCommandHandler('writeFile', (socket, _adapter, fileName, data, options, callback) => {
            if (this.checkPermissions(socket, 'writeFile', callback, fileName)) {
                if (typeof options === 'function') {
                    callback = options;
                    options = { user: socket._acl!.user };
                }
                options = options || {};
                options.user = socket._acl!.user;

                this.adapter.log.warn('writeFile deprecated. Please use writeFile64');
                // const buffer = Buffer.from(data64, 'base64');
                this.adapter.writeFile(_adapter, fileName, data, { user: socket._acl!.user }, (err, ...args) => {
                    if (typeof callback !== 'function') {
                        return;
                    }

                    if (err instanceof Error) {
                        callback(err.message, ...args);
                    } else {
                        callback(err, ...args);
                    }
                });
            }
        });

        this.addCommandHandler('mc', (socket, socketId, command, ...args) => {
            // Arguments: socket.id, command, arg1...argN, cb
            const handler = this.commands?.getCommandHandler(command);
            if (handler) {
                // Create sub-socket if not exists
                socket._subSockets = socket._subSockets || {};

                if (!socket._subSockets[socketId]) {
                    socket._subSockets[socketId] = {
                        id: socketId,
                        ___socket: socket, // store the main socket under ___socket
                        _acl: socket._acl,
                    } as SocketClient;
                }

                handler(socket._subSockets[socketId], ...args);
            } else if (command === 'll') {
                // lovelace
                const remoteSocketId = socketId;
                if (!this.lovelaceServer) {
                    this.adapter.log.info(
                        `[Lovelace|${remoteSocketId}] received lovelace command, but lovelace is not enabled in config`,
                    );
                } else {
                    try {
                        const data = JSON.parse(args[0]);

                        if (data.type === 'connection') {
                            this.sendToLovelace(socket, remoteSocketId);
                        } else if (data.type === 'close') {
                            this.adapter.log.info(`[Lovelace|${remoteSocketId}] remote client disconnected`);
                            if (this.lovelaceSockets[remoteSocketId]) {
                                this.lovelaceSockets[remoteSocketId].socket?.close();
                                delete this.lovelaceSockets[remoteSocketId];
                            }
                        } else if (data.type === 'error') {
                            this.adapter.log.error(`[Lovelace|${remoteSocketId}] remote client: ${data.error}`);
                        } else {
                            this.sendToLovelace(socket, remoteSocketId, args[0]);
                        }
                    } catch {
                        this.adapter.log.error(`[Lovelace|${remoteSocketId}] Cannot parse: ${args[0]}`);
                    }
                }
            } else {
                this.adapter.log.error(`Received unknown command 1: ${command}`);

                let func = null;
                for (let a = args.length - 1; a >= 0; a--) {
                    if (typeof args[a] === 'function') {
                        func = args[a];
                        break;
                    }
                }

                func?.('unknown command');
            }
        });
    }

    send(socket: SocketClient, cmd: 'ifttt', data?: any): void;

    send(socket: SocketClient, cmd: 'pingg'): void;

    send(socket: SocketClient, cmd: 'objectChange', id: string, data: ioBroker.Object | null | undefined): void;

    send(socket: SocketClient, cmd: 'stateChange', id: string, data: ioBroker.State | null | undefined): void;

    send(socket: SocketClient, cmd: 'log', msg: ioBroker.LogMessage): void;

    send(
        socket: SocketClient,
        cmd: 'cmdStdout' | 'cmdStderr' | 'cmdExit' | 'getHostInfo',
        id?: string | ioBroker.LogMessage,
        data?: any,
    ): void;

    send(socket: unknown, cmd: unknown, id?: unknown, data?: unknown): void {
        // if it is sub-socket => get the main socket
        if ((socket as SocketClient)?.___socket) {
            socket = (socket as SocketClient).___socket;
        }

        if ((socket as SocketClient)._apiKeyOk) {
            // send on all clients
            (socket as SocketClient).emit(cmd as string, id, data);
        }
    }

    on(
        event:
            | 'connect'
            | 'disconnect'
            | 'cloudError'
            | 'cloudConnect'
            | 'cloudDisconnect'
            | 'connectWait'
            | 'cloudRedirect'
            | 'cloudStop',
        handler: (...args: any[]) => void,
    ): void {
        this.events.on(event, handler);
    }

    stopAdapter(data?: { reason: string }): void {
        this.adapter.log.warn(`Adapter stopped. Reason: ${data?.reason ? data.reason : 'command from server'}`);
        this.events.emit('cloudStop');
    }

    redirectAdapter(data: any): void {
        this.events.emit('cloudRedirect', data);
    }

    waitForConnect(data?: { delaySeconds?: number }): void {
        this.events.emit('connectWait', data ? data.delaySeconds || 30 : 30);
    }

    sendToLovelace(ioSocket: SocketClient, remoteSocketId: string, dataStr?: string): void {
        let llSocket = this.lovelaceSockets[remoteSocketId];
        if (!this.lovelaceServer) {
            this.adapter.log.warn(`[Lovelace] disabled!`);
            return;
        }

        if (llSocket?.connected) {
            this.adapter.log.debug(`[Lovelace|${remoteSocketId}] send: ${dataStr}`);
            if (dataStr) {
                llSocket.socket?.send(dataStr);
            }
        } else {
            if (!llSocket) {
                this.adapter.log.debug(`[Lovelace|${remoteSocketId}] establish connection`);
                this.lovelaceSockets[remoteSocketId] = llSocket = {
                    socket: null,
                    connected: false,
                    messages: dataStr ? [dataStr] : [],
                };
                llSocket.socket = new WebSocket(
                    `${this.lovelaceServer.replace(/^https/, 'wss').replace(/^http/, 'ws')}/api/websocket`,
                );

                llSocket.socket.on('open', () => {
                    llSocket.connected = true;
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] connected`);
                    if (llSocket.messages) {
                        llSocket.messages.forEach(message => llSocket.socket!.send(message));
                        llSocket.messages = null;
                    }
                });

                llSocket.socket.on('close', () => {
                    llSocket.connected = false;
                    delete this.lovelaceSockets[remoteSocketId];
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected`);
                });

                llSocket.socket.on('message', (data: Buffer | string, isBinary?: boolean) => {
                    const message: string | Buffer = isBinary ? data : data.toString();
                    llSocket.connected = true;
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] received ${message.toString()}`);
                    ioSocket.emit('ll', remoteSocketId, message);
                });

                llSocket.socket.on('error', error => {
                    llSocket.connected = true;
                    delete this.lovelaceSockets[remoteSocketId];
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected: ${error}`);
                });
            }

            if (dataStr) {
                this.adapter.log.debug(`[Lovelace|${remoteSocketId}] store message: ${dataStr}`);
                llSocket.messages?.push(dataStr);
            }
        }
    }
}
