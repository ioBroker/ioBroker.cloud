const EventEmitter = require('events');
const WebSocket    = require('ws'); // used for lovelace
const SocketAdmin  = require('@iobroker/socket-classes').SocketAdmin;
// const SocketAdmin  = require('./socketAdmin');

process.on('uncaughtException', function (err) {
    debugger;
    // Handle the error safely
    console.error(err)
});

// From settings used only secure, auth and crossDomain
class SocketCloud extends SocketAdmin {
    constructor(socket, settings, adapter, lovelaceServer) {
        super(settings, adapter);
        this.lovelaceSockets = {};
        this.lovelaceServer = lovelaceServer;
        this.events = new EventEmitter();

        socket._apiKeyOk = false;

        this.addEventHandler('disconnect', socket => {
            socket._apiKeyOk = false;
            this.events.emit('disconnect');
        });

        this.initCommandsCloud();

        this.start(socket);

        // install handlers on socket
        this._initSocket(socket);
    }

    __getClientAddress(socket) {
        return 'cloud';
    }

    // update session ID, but not ofter than 60 seconds
    __updateSession(socket) {
        // if it is sub-socket => get main socket
        if (socket && socket.___socket) {
            socket = socket.___socket;
        }
        if (socket._sessionID) {
            const time = Date.now();
            if (socket._lastActivity && time - socket._lastActivity > this.settings.ttl * 1000) {
                socket.emit('reauthenticate');
                socket.disconnect();
                return false;
            }

            socket._lastActivity = time;

            if (!socket._sessionTimer) {
                socket._sessionTimer = setTimeout(() => {
                    socket._sessionTimer = null;
                    this.store.get(socket._sessionID,  (err, obj) => {
                        if (obj) {
                            this.adapter.setSession(socket._sessionID, this.settings.ttl, obj);
                        } else {
                            socket.emit('reauthenticate');
                            socket.disconnect();
                        }
                    });
                }, 60000);
            }
        }

        return true;
    }

    initCommandsCloud() {
        // remove standard error handler
        this.addCommandHandler('error');

        this.addCommandHandler('cloudDisconnect', (socket, socketId, err) => {
            // if it is sub-socket => get main socket (should never happen)
            if (socket && socket.___socket) {
                debugger;
                socket = socket.___socket;
            }

            // error could be a time. Detect if it is on the first place (old cloud)
            if (socketId && !isNaN(parseInt(socketId.toString().substring(0, 4), 10))) {
                err = socketId;
                socketId = 0;
            }

            err && this.adapter.log.warn(`User disconnected from cloud: ${socketId} ${err}`);

            if (socket._subSockets && socketId) {
                if (socket._subSockets[socketId]) {
                    this.unsubscribeSocket(socket._subSockets[socketId]);
                    if (socket._subSockets[socketId]) {
                        delete socket._subSockets[socketId];
                    }
                } else {
                    this.adapter.log.warn('Received disconnection for non-existing socketId: ' + socketId)
                }
            } else {
                this.unsubscribeSocket(socket);

                // unsubscribe all sub-sockets, because client does not use mutli-client
                if (socket._subSockets) {
                    Object.keys(socket._subSockets)
                        .forEach(socketId => {
                            this.unsubscribeSocket(socket._subSockets[socketId]);
                            if (socket._subSockets[socketId]) {
                                delete socket._subSockets[socketId];
                            }
                        });
                    delete socket._subSockets;
                }
            }

            this.events.emit('cloudDisconnect', socketId, socket._name);
        });

        this.addCommandHandler('cloudVersion', (socket, apiVersion) => {
            // if it is sub-socket => get main socket (should never happen)
            if (socket && socket.___socket) {
                debugger;
                socket = socket.___socket;
            }
            this.adapter.log.debug('Cloud version: ' + apiVersion);
            if (socket) {
                socket.__apiVersion = apiVersion;
            }
        });

        this.addCommandHandler('cloudConnect', (socket, socketId) => {
            if (!socket.___socket) {
                socket._subSockets = socket._subSockets || {};
                socket._subSockets[socketId] = socket._subSockets[socketId] || {
                    id: socketId,
                    ___socket: socket, // store main socket under ___socket
                    _acl: socket._acl
                }
            }
            // do not auto-subscribe. The client must resubscribe all states anew
            // this._subscribeSocket(socket, 'stateChange');
            // this._subscribeSocket(socket, 'objectChange');
            // this._subscribeSocket(socket, 'log');
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

        // restore WEB version of write file (without base64)
        this.addCommandHandler('writeFile', (socket, _adapter, fileName, data, options, callback) => {
            if (this.checkPermissions(socket, 'writeFile', callback, fileName)) {
                if (typeof options === 'function') {
                    callback = options;
                    options = {user: socket._acl.user};
                }
                options = options || {};
                options.user = socket._acl.user;

                this.adapter.log.warn('writeFile deprecated. Please use writeFile64');
                // const buffer = Buffer.from(data64, 'base64');
                this.adapter.writeFile(_adapter, fileName, data, {user: socket._acl.user}, (err, ...args) => {
                    if (typeof callback !== 'function') {
                        return;
                    }

                    if (err instanceof Error) {
                        err = err.message;
                    }

                    callback(err, ...args);
                });
            }
        });

        this.addCommandHandler('mc', (socket, socketId, command, ...args) => {
            // Arguments: socket.id, command, arg1..argN, cb
            const handler = this.commands.getCommandHandler(command);
            if (handler) {
                // Create sub-socket if not exists
                socket._subSockets = socket._subSockets || {};

                if (!socket._subSockets[socketId]) {
                    socket._subSockets[socketId] = {
                        id: socketId,
                        ___socket: socket, // store main socket under ___socket
                        _acl: socket._acl
                    };
                }

                handler(socket._subSockets[socketId], ...args);
            } else if (command === 'll') { // lovelace
                const remoteSocketId = socketId;
                if (!this.lovelaceServer) {
                    this.adapter.log.info(`[Lovelace|${remoteSocketId}] received lovelace command, but lovelace is not enabled in config`);
                } else {
                    try {
                        const data = JSON.parse(args[0]);

                        if (data.type === 'connection') {
                            this.sendToLovelace(socket, remoteSocketId);
                        } else if (data.type === 'close') {
                            this.adapter.log.info(`[Lovelace|${remoteSocketId}] remote client disconnected`);
                            this.lovelaceSockets[remoteSocketId] && this.lovelaceSockets[remoteSocketId].socket.close();
                            delete this.lovelaceSockets[remoteSocketId];
                        } else if (data.type === 'error') {
                            this.adapter.log.error(`[Lovelace|${remoteSocketId}] remote client: ${data.error}`);
                        } else {
                            this.sendToLovelace(socket, remoteSocketId, args[0]);
                        }
                    } catch (e) {
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

                func && func('unknown command');
            }
        });

        this.addCommandHandler('connect', socket => {
            socket._subSockets = {};
            this.adapter.log.debug('Connected. Check api key...');
            socket._apiKeyOk = false;

            // send api key if exists
            socket.emit('apikey', this.settings.apikey, this.settings.version, this.settings.uuid, (err, instructions) => {
                // instructions = {
                //     validTill: '2018-03-14T01:01:01.567Z',
                //     command: 'wait' | 'stop' | 'redirect'
                //     delaySeconds: seconds for wait
                //     reason: Description of command
                //     url: redirect URL
                //     notSave: true | false for url. Save it or just use it

                if (instructions) {
                    if (typeof instructions !== 'object') {
                        this.adapter.setState('info.remoteTill', new Date(instructions).toISOString(), true);
                    } else {
                        if (instructions.validTill) {
                            this.adapter.setState('info.remoteTill', new Date(instructions.validTill).toISOString(), true);
                        }
                        if (instructions.command === 'stop') {
                            return this.stopAdapter(instructions);
                        } else if (instructions.command === 'redirect') {
                            return this.redirectAdapter(instructions);
                        } else if (instructions.command === 'wait') {
                            return this.waitForConnect(instructions);
                        }
                    }
                }

                if (!err) {
                    this.adapter.log.debug('API KEY OK');
                    socket._apiKeyOk = true;

                    this.events.emit('connect');
                } else {
                    if (err.includes('Please buy remote access to use pro.')) {
                        this.stopAdapter('Please buy remote access to use pro.');
                    }
                    this.adapter.log.error(err);
                    socket.close(); // disconnect
                }
            });
        });
    }

    send(socket, cmd, id, data) {
        // if it is sub-socket => get main socket
        if (socket && socket.___socket) {
            socket = socket.___socket;
        }

        if (socket._apiKeyOk) {
            // send on all clients
            socket.emit(cmd, id, data);
        }
    };

    on(event, handler) {
        this.events.on(event, handler);
    }

    stopAdapter(data) {
        this.adapter.log.warn(`Adapter stopped. Reason: ${data && data.reason ? data.reason : 'command from server'}`);
        this.events.emit('cloudStop');
    }

    redirectAdapter(data) {
        this.events.emit('cloudRedirect', data);
    }

    waitForConnect(data) {
        this.events.emit('connectWait', data ? data.delaySeconds || 30 : 30);
    }

    sendToLovelace(ioSocket, remoteSocketId, dataStr) {
        let llSocket = this.lovelaceSockets[remoteSocketId];
        if (llSocket && llSocket.connected) {
            this.adapter.log.debug(`[Lovelace|${remoteSocketId}] send: ${dataStr}`);
            dataStr && llSocket.socket.send(dataStr);
        } else {
            if (!llSocket) {
                this.adapter.log.debug(`[Lovelace|${remoteSocketId}] establish connection`);
                this.lovelaceSockets[remoteSocketId] = llSocket = {socket: null, connected: false, messages: dataStr ? [dataStr] : []};
                llSocket.socket = new WebSocket(`${this.lovelaceServer.replace(/^https/, 'wss').replace(/^http/, 'ws')}/api/websocket`);

                llSocket.socket.on('open', () => {
                    llSocket.connected = true;
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] connected`);
                    llSocket.messages && llSocket.messages.forEach(message =>
                        llSocket.socket.send(message));
                    llSocket.messages = null;
                });

                llSocket.socket.on('close', () => {
                    llSocket.connected = false;
                    delete this.lovelaceSockets[remoteSocketId];
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected`);
                });

                llSocket.socket.on('message', (data, isBinary) => {
                    const message = isBinary ? data : data.toString();
                    llSocket.connected = true;
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] received ${message}`);
                    ioSocket.emit('ll', remoteSocketId, message);
                });

                llSocket.socket.on('error', error => {
                    llSocket.connected = true;
                    delete this.lovelaceSockets[remoteSocketId];
                    this.adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected: ` + error);
                });
            }

            this.adapter.log.debug(`[Lovelace|${remoteSocketId}] store message: ${dataStr}`)
            llSocket.messages.push(dataStr);
        }
    }
}

module.exports = SocketCloud;
