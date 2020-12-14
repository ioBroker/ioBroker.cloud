/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
//let IOSocket      = require(utils.appName + '.socketio/lib/socket.js');
const IOSocket      = require('./lib/socket.js'); // temporary
const request       = require('request');
const pack          = require('./io-package.json');
const adapterName   = require('./package.json').name.split('.').pop();

let socket          = null;
let ioSocket        = null;

let detectDisconnect = null;
let pingTimer       = null;
let connected       = false;
let connectTimer    = null;
let uuid            = null;
let waiting         = false;
let apikey          = '';

let TEXT_PING_TIMEOUT = 'Ping timeout';

let adapter;
function startAdapter(options) {
    options = options || {};
    Object.assign(options,{
        name:         adapterName,
        objectChange: (id, obj) => ioSocket && ioSocket.send(socket, 'objectChange', id, obj),
        stateChange: (id, state) => {
            if (socket) {
                if (id === adapter.namespace + '.services.ifttt' && state && !state.ack) {
                    sendDataToIFTTT({
                        id: id,
                        val: state.val,
                        ack: false
                    });
                } else {
                    ioSocket && ioSocket.send(socket, 'stateChange', id, state);
                }
            }
        },
        unload: callback => {
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            if (detectDisconnect) {
                clearTimeout(detectDisconnect);
                detectDisconnect = null;
            }
            try {
                if (socket) {
                    socket.close();
                }
                ioSocket = null;
                callback();
            } catch (e) {
                callback();
            }
        },
        message: obj => {
            if (obj) {
                switch (obj.command) {
                    case 'ifttt':
                        sendDataToIFTTT(obj.message);
                        break;

                    default:
                        adapter.log.warn('Unknown command: ' + obj.command);
                        break;
                }
            }
        },
        ready: () => createInstancesStates(main)
    });

    adapter = new utils.Adapter(options);

    return adapter;
}

function sendDataToIFTTT(obj) {
    if (!obj) {
        adapter.log.warn('No data to send to IFTTT');
        return;
    }
    if (!adapter.config.iftttKey && (typeof obj !== 'object' || !obj.key)) {
        adapter.log.warn('No IFTTT key is defined');
        return;
    }
    if (typeof obj !== 'object') {
        ioSocket && ioSocket.send(socket, 'ifttt', {
            id:     adapter.namespace + '.services.ifttt',
            key:    adapter.config.iftttKey,
            val:    obj
        });
    } else if (obj.event) {
        ioSocket && ioSocket.send(socket, 'ifttt', {
            event:  obj.event,
            key:    obj.key || adapter.config.iftttKey,
            value1: obj.value1,
            value2: obj.value2,
            value3: obj.value3
        });
    } else {
        if (obj.val === undefined) {
            adapter.log.warn('No value is defined');
            return;
        }
        obj.id = obj.id || (adapter.namespace + '.services.ifttt');
        ioSocket && ioSocket.send(socket, 'ifttt', {
            id:  obj.id,
            key: obj.key || adapter.config.iftttKey,
            val: obj.val,
            ack: obj.ack
        });
    }
}

function pingConnection() {
    if (!detectDisconnect) {
        if (connected && ioSocket) {
            // cannot use "ping" because reserved by socket.io
            ioSocket.send(socket, 'pingg');

            detectDisconnect = setTimeout(() => {
                detectDisconnect = null;
                adapter.log.error(TEXT_PING_TIMEOUT);
                onDisconnect(TEXT_PING_TIMEOUT);
            }, adapter.config.pingTimeout);
        }
    }
}

function checkPing() {
    if (connected) {
        pingTimer = pingTimer || setInterval(pingConnection, 30000);
    } else {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (detectDisconnect) {
            clearTimeout(detectDisconnect);
            detectDisconnect = null;
        }
    }
}

function controlState(id, data, callback) {
    id = id || 'services.ifttt';

    if (typeof data === 'object') {
        if (data.id) {
            if (data.id === adapter.namespace + '.services.ifttt') {
                data.ack = true;
            }
            if (data.val === undefined) {
                callback && callback('No value set');
                return;
            }
            adapter.getForeignObject(data.id, (err, obj) => {
                if (!obj || !obj.common) {
                    callback && callback('Unknown ID: ' + data.id);
                } else {
                    if (typeof data.val === 'string') {
                        data.val = data.val.replace(/^@ifttt\s?/, '');
                    }
                    if (obj.common.type === 'boolean') {
                        data.val = data.val === true || data.val === 'true' || data.val === 'on' || data.val === 'ON' || data.val === 1 || data.val === '1';
                    } else if (obj.common.type === 'number') {
                        data.val = parseFloat(data.val);
                    }

                    adapter.setForeignState(data.id, data.val, data.ack, callback);
                }
            });
        } else if (data.val !== undefined) {
            if (typeof data.val === 'string') {
                data.val = data.val.replace(/^@ifttt\s?/, '');
            }
            adapter.setState(id, data.val, data.ack !== undefined ? data.ack : true, callback);
        } else {
            if (typeof data === 'string') {
                data = data.replace(/^@ifttt\s?/, '');
            }
            adapter.setState(id, JSON.stringify(data), true, callback);
        }
    } else {
        if (typeof data === 'string') {
            data = data.replace(/^@ifttt\s?/, '');
        }
        adapter.setState(id, data, true, callback);
    }
}

function processIfttt(data, callback) {
    adapter.log.debug('Received IFTTT object: ' + data);
    let id;
    if (typeof data === 'object' && data.id && data.data !== undefined) {
        id = data.id;
        if (typeof data.data === 'string' && data.data[0] === '{') {
            try {
                data = JSON.parse(data.data);
            } catch (e) {
                adapter.log.debug('Cannot parse: ' + data.data);
            }
        } else {
            data = data.data;
        }
    } else {
        if (typeof data === 'string' && data[0] === '{') {
            try {
                data = JSON.parse(data);

                if (typeof data.id === 'string') {
                    id = data.id;
                    if (data.data) {
                        data = data.data;
                    }
                }
            } catch (e) {
                adapter.log.debug('Cannot parse: ' + data);
            }
        }
    }

    if (id) {
        adapter.getForeignObject(id, (err, obj) => {
            if (obj) {
                controlState(id, data, callback);
            } else {
                adapter.getForeignObject(adapter.namespace + '.services.'  + id, (err, obj) => {
                    if (!obj) {
                        // create state
                        adapter.setObject('services.' + id, {
                                type: 'state',
                                common: {
                                    name: 'IFTTT value',
                                    write: false,
                                    role: 'state',
                                    read: true,
                                    type: 'mixed',
                                    desc: 'Custom state'
                                },
                                native: {}
                            },
                            () => controlState(adapter.namespace + '.services.'  + id, data, callback));
                    } else {
                        controlState(obj._id, data, callback);
                    }
                });
            }
        });
    } else {
        controlState(null, data, callback);
    }
}

function onDisconnect(event) {
    if (typeof event === 'string') {
        adapter.log.info('Connection changed: ' + event);
    } else {
        adapter.log.info('Connection changed: disconnect');
    }

    if (connected) {
        adapter.log.info('Connection lost');
        connected = false;
        adapter.setState('info.connection', false, true);

        // clear ping timers
        checkPing();

        if (adapter.config.restartOnDisconnect) {
            // simulate scheduled restart
            setTimeout(() => adapter.terminate ? adapter.terminate(-100): process.exit(-100), 10000);
        } else {
            startConnect();
        }
    }
}

function onConnect() {
    if (!connected) {
        adapter.log.info('Connection changed: connect');
        connected = true;
        adapter.setState('info.connection', connected, true);
        checkPing();
    } else {
        adapter.log.info('Connection not changed: was connected');
    }

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
}

function onCloudConnect(clientId) {
    adapter.log.info('User accessed from cloud: ' + (clientId || ''));
    adapter.setState('info.userOnCloud', true, true);
}

function onCloudDisconnect(clientId, name) {
    adapter.log.info('User disconnected from cloud: ' + (clientId || '') + ' ' + (name || ''));
    adapter.setState('info.userOnCloud', false, true);
}

function onCloudWait(seconds) {
    waiting = true;
    adapter.log.info('Server asked to wait for ' + (seconds || 60) + ' seconds');
    if (socket) {
        socket.disconnect();
        socket.off();
        socket = null;
    }
    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }

    setTimeout(() => {
        waiting = false;
        startConnect(true);
    }, (seconds * 1000) || 60000);
}

function onCloudRedirect(data) {
    if (!data) {
        adapter.log.info('Received invalid redirect command from server');
        return;
    }
    if (!data.url) {
        adapter.log.error('Received redirect, but no URL.');
    } else
    if (data.notSave) {
        adapter.log.info('Adapter redirected temporally to "' + data.url + '" in one minute. Reason: ' + (data && data.reason ? data.reason : 'command from server'));
        adapter.config.cloudUrl = data.url;
        if (socket) {
            socket.disconnect();
            socket.off();
        }
        startConnect();
    } else {
        adapter.log.info('Adapter redirected continuously to "' + data.url + '". Reason: ' + (data && data.reason ? data.reason : 'command from server'));
        adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
            err && adapter.log.error('redirectAdapter [getForeignObject]: ' + err);
            if (obj) {
                obj.native.cloudUrl = data.url;
                setTimeout(() => {
                    adapter.setForeignObject(obj._id, obj, err => {
                        err && adapter.log.error('redirectAdapter [setForeignObject]: ' + err);

                        adapter.config.cloudUrl = data.url;
                        if (socket) {
                            socket.disconnect();
                            socket.off();
                        }
                        startConnect();
                    });
                }, 3000);
            }
        });
    }
}

function onCloudError(error) {
    adapter.log.error('Cloud says: ' + error);
}

function onCloudStop(data) {
    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
        err && adapter.log.error(`[getForeignObject]: ${err}`);
        if (obj) {
            obj.common.enabled = false;
            setTimeout(() =>
                adapter.setForeignObject(obj._id, obj, err => {
                    err && adapter.log.error('[setForeignObject]: ' + err);
                    adapter.terminate ? adapter.terminate(): process.exit();
                }), 5000);
        } else {
            adapter.terminate ? adapter.terminate(): process.exit();
        }
    });
}

// this is bug of scoket.io
// sometimes auto-reconnect does not work.
function startConnect(immediately) {
    if (waiting) return;

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
    connectTimer = setInterval(connect, 60000);
    if (immediately) {
        connect();
    }
}

function initConnect(socket, options) {
    ioSocket = new IOSocket(socket, options, adapter);

    ioSocket.on('connect',         onConnect);
    ioSocket.on('disconnect',      onDisconnect);
    ioSocket.on('cloudError',      onCloudError);
    ioSocket.on('cloudConnect',    onCloudConnect);
    ioSocket.on('cloudDisconnect', onCloudDisconnect);
    ioSocket.on('connectWait',     onCloudWait);
    ioSocket.on('cloudRedirect',   onCloudRedirect);
    ioSocket.on('cloudStop',       onCloudStop);
}

function connect() {
    if (waiting) return;

    adapter.log.debug('Connection attempt to ' + (adapter.config.cloudUrl || 'https://iobroker.net:10555') + ' ...');

    if (socket) {
        socket.off();
        socket.disconnect();
    }

    socket = require('socket.io-client')(adapter.config.cloudUrl || 'https://iobroker.net:10555', {
        transports:           ['websocket'],
        autoConnect:          true,
        reconnection:         !adapter.config.restartOnDisconnect,
        rejectUnauthorized:   !adapter.config.allowSelfSignedCertificate,
        randomizationFactor:  0.9,
        reconnectionDelay:    60000,
        timeout:              parseInt(adapter.config.connectionTimeout, 10) || 10000,
        reconnectionDelayMax: 120000
    });

    socket.on('connect_error', error => adapter.log.error('Error while connecting to cloud: ' + error));

    // cannot use "pong" because reserved by socket.io
    socket.on('pongg', (/*error*/) => {
        clearTimeout(detectDisconnect);
        detectDisconnect = null;
    });

    let server      = 'http://localhost:8082';
    let adminServer = 'http://localhost:8081';

    socket.on('html', (url, cb) => {
        if (url.match(/^\/admin\//)) {
            if (adminServer && adapter.config.allowAdmin) {
                url = url.substring(6);
                request({url: adminServer + url, encoding: null}, (error, response, body) =>
                    cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
            } else {
                cb('Enable admin in cloud settings. And only pro.', 404, [], 'Enable admin in cloud settings. And only pro.');
            }
        } else if (adminServer && adapter.config.allowAdmin && url.match(/^\/adapter\/|^\/lib\/js\/ace-|^\/lib\/js\/cron\/|^\/lib\/js\/jqGrid\//)) {
            request({url: adminServer + url, encoding: null}, (error, response, body) =>
                cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
        } else if (server) {
            request({url: server + url, encoding: null}, (error, response, body) =>
                cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
        } else {
            cb('Admin or Web are inactive.', 404, [], 'Admin or Web are inactive.');
        }
    });

    socket.on('ifttt', processIfttt);

    socket.on('iftttError', error => adapter.log.error('Error from IFTTT: ' + JSON.stringify(error)));

    socket.on('cloudError', error => adapter.log.error('Cloud says: ' + error));

    socket.on('service', (data, callback) => {
        adapter.log.debug('service: ' + JSON.stringify(data));
        // supported services:
        // - text2command
        // - simpleApi
        // - custom, e.g. torque
        if (!data || !data.name) {
            callback && callback({error: 'no name'});
        } else
        if (data.name === 'ifttt' && adapter.config.iftttKey) {
            processIfttt(data.data, callback);
        } else {
            let isCustom = false;
            if (data.name.match(/^custom_/)) {
                data.name = data.name.substring(7);
                isCustom = true;
            }

            if (adapter.config.allowedServices[0] === '*' || adapter.config.allowedServices.indexOf(data.name) !== -1) {
                if (!isCustom && data.name === 'text2command') {
                    if (adapter.config.text2command !== undefined && adapter.config.text2command !== '') {
                        adapter.setForeignState('text2command.' + adapter.config.text2command + '.text', decodeURIComponent(data.data), err =>
                            callback && callback({result: err || 'Ok'}));
                    } else {
                        adapter.log.warn('Received service text2command, but instance is not defined');
                        callback && callback({error: 'but instance is not defined'});
                    }
                } else if (!isCustom && (data.name === 'simpleApi' || data.name === 'simpleapi')) {
                    // GET https://iobroker.net/service/simpleApi/<user-app-key>/get/system.adapter.admin.0.cputime
                    const parts = (data.data || '').split('/');
                    if (parts[0] === 'get') {
                        adapter.getForeignState(parts[1], (error, state) => {
                            if (error) {
                                callback && callback({error});
                            } else {
                                state.result = 'Ok';
                                callback && callback(state);
                            }
                        });
                    } else if (parts[0] === 'getPlainValue') {
                        adapter.getForeignState(parts[1], (error, state) => {
                            if (error) {
                                callback && callback({error});
                            } else {
                                callback && callback({result: 'Ok', val: state.val, plain: true});
                            }
                        });
                    } else if (parts[0] === 'set') {
                        // https://iobroker.pro/service/simpleapi/<user-app-key>/set/stateID?value=1
                        let [id, val] = parts[1].split('?');
                        val = val.replace(/^value=/, '');
                        adapter.getForeignObject(id, (error, obj) => {
                            if (error || !obj) {
                                callback && callback({error: error || 'not found'});
                            } else if (obj.type !== 'state') {
                                callback && callback({error: 'only states could be controlled'});
                            } else {
                                if (obj.common && obj.common.type === 'boolean') {
                                    val = val === 'true' || val === '1' || val === 'ON' || val === 'on';
                                } else if (obj.common && obj.common.type === 'number') {
                                    val = parseFloat(val);
                                }
                                adapter.setForeignState(id, val, error => {
                                    if (error) {
                                        callback && callback({error});
                                    } else {
                                        callback && callback({result: 'Ok'});
                                    }
                                });
                            }
                        });

                    } else {
                        callback && callback({error: 'not implemented'});
                    }
                } else if (isCustom) {
                    adapter.getObject('services.custom_' + data.name, (err, obj) => {
                        if (!obj) {
                            adapter.setObject('services.custom_' + data.name, {
                                _id: adapter.namespace + '.services.custom_' + data.name,
                                type: 'state',
                                common: {
                                    name: 'Service for ' + data.name,
                                    write: false,
                                    read: true,
                                    type: 'mixed',
                                    role: 'value'
                                },
                                native: {}
                            }, err => {
                                if (!err) {
                                    adapter.setState('services.custom_' + data.name, data.data, false, err => callback && callback({result: err || 'Ok'}));
                                } else {
                                    callback && callback({result: err});
                                }
                            });
                        } else {
                            adapter.setState('services.custom_' + data.name, data.data, false, err => callback && callback({result: err || 'Ok'}));
                        }
                    });
                } else {
                    callback && callback({error: 'not allowed'});
                }
            } else {
                adapter.log.warn('Received service "' + data.name + '", but it is not found in whitelist');
                callback && callback({error: 'blocked'});
            }
        }
    });

    socket.on('error', error => startConnect());

    if (adapter.config.instance) {
        if (adapter.config.instance.substring(0, 'system.adapter.'.length) !== 'system.adapter.') {
            adapter.config.instance = 'system.adapter.' + adapter.config.instance;
        }

        adapter.getForeignObject(adapter.config.instance, (err, obj) => {
            if (obj && obj.common && obj.native) {
                if (obj.common.auth) {
                    adapter.log.error('Cannot activate web for cloud, because authentication is enabled. Please create extra instance for cloud');
                    server = '';
                    return;
                }
                if (obj.common.secure) {
                    adapter.log.error('Cannot activate web for cloud, because HTTPs is enabled. Please create extra instance for cloud');
                    server = '';
                    return;
                }

                server = `http${obj.native.secure ? 's' : ''}://`;
                // todo if run on other host
                server += (!obj.native.bind || obj.native.bind === '0.0.0.0') ? '127.0.0.1' : obj.native.bind;
                server += ':' + obj.native.port;

                initConnect(socket, {apikey, allowAdmin: adapter.config.allowAdmin, uuid: uuid, version: pack.common.version});
            } else {
                adapter.log.error(`Unknown instance ${adapter.log.instance}`);
                server = null;
            }
        });

        if (adapter.config.allowAdmin) {
            adapter.getForeignObject(adapter.config.allowAdmin, (err, obj) => {
                if (obj && obj.common && obj.native) {
                    if (obj.common.auth) {
                        adapter.log.error('Cannot activate admin for cloud, because authentication is enabled. Please create extra instance for cloud');
                        server = '';
                        return;
                    }
                    adminServer = `http${obj.native.secure ? 's' : ''}://`;
                    // todo if run on other host
                    adminServer += (!obj.native.bind || obj.native.bind === '0.0.0.0') ? '127.0.0.1' : obj.native.bind;
                    adminServer += ':' + obj.native.port;
                } else {
                    adminServer = null;
                    adapter.log.error('Unknown instance ' + adapter.config.allowAdmin);
                }
            });
        }
    } else {
        initConnect(socket, {apikey, uuid: uuid, version: pack.common.version});
    }
}

function createInstancesStates(callback, objs) {
    if (!objs) {
        const pack = require(__dirname + '/io-package.json');
        objs = pack.instanceObjects;
    }
    if (!objs || !objs.length) {
        callback();
    } else {
        const obj = objs.shift();
        adapter.getObject(obj._id, (err, _obj) => {
            if (!_obj) {
                adapter.setObject(obj._id, obj, err => {
                    err && adapter.log.error(`Cannot setObject: ${err}`);
                    setImmediate(createInstancesStates, callback, objs);
                });
            } else {
                setImmediate(createInstancesStates, callback, objs);
            }
        });
    }
}

function _createAppKey(cb) {
    adapter.log.info('Create new APP-KEY...')
    request({
        method: 'POST',
        url: `https://${adapter.config.server}:3001/api/v1/appkeys`,
        headers : {
            Authorization: 'Basic ' + Buffer.from(`${adapter.config.login}:${adapter.config.pass}`).toString('base64')
        }
    }, (err, state, body) => {
        if (body) {
            try {
                body = JSON.parse(body);
            } catch (e) {
                cb(`Cannot parse answer from server: ${e}`);
            }
            if (body && body.key && body.key[0]) {
                adapter.log.info(`New APP-KEY is ${body.key[0]}`);
                cb(null, body.key[0]);
            } else {
                cb(`Cannot create app-key on server: ${err || state.statusCode || JSON.stringify(body)}`);
            }
        } else {
            // retry in 20 seconds if server unavailable
            if (err.code === 'ECONNREFUSED') {
                adapter.log.warn('Server is offline or no connection. Retry in 10 seconds');
                setTimeout(() => _createAppKey(cb), 10000);
            } else {
                cb(`Cannot create app-key on server: ${err || state.statusCode}`);
            }
        }
    });
}

function _readAppKeyFromCloud(cb) {
    request({
        url: `https://${adapter.config.server}:3001/api/v1/appkeys`,
        headers : {
            Authorization: 'Basic ' + Buffer.from(`${adapter.config.login}:${adapter.config.pass}`).toString('base64')
        }
    }, (err, state, body) => {
        if (body) {
            try {
                body = JSON.parse(body);
            } catch (e) {
                cb(`Cannot parse answer from server: ${e}`);
            }
            if (body[0]) {
                cb(null, body[0].key);
            } else if (body) {
                _createAppKey(cb);
            } else {
                // todo: create key
                cb(`Cannot find app-key on server: ${err || state.statusCode || 'key does not exist'}`);
            }
        } else {
            // todo: retry in 20 seconds if server unavailable
            if (err.code === 'ECONNREFUSED') {
                adapter.log.warn('Server is offline or no connection. Retry in 10 seconds');
                setTimeout(() => _readAppKeyFromCloud(cb), 10000);
            } else {
                cb(`Cannot find app-key on server: ${err || state.statusCode}`);
            }
        }
    });
}

function readAppKeyFromCloud(_resolve, _reject) {
    if (!_resolve) {
        return new Promise((resolve, reject) =>
            readAppKeyFromCloud(resolve, reject));
    } else {
        _readAppKeyFromCloud((err, key) =>
            err ? _reject(err) : _resolve(key));
    }
}

function main() {
    adapter.config.pingTimeout = parseInt(adapter.config.pingTimeout, 10) || 5000;
    if (adapter.config.pingTimeout < 3000) {
        adapter.config.pingTimeout = 3000;
    }

    if (adapter.config.deviceOffLevel === undefined) {
        adapter.config.deviceOffLevel = 30;
    }

    adapter.config.deviceOffLevel = parseFloat(adapter.config.deviceOffLevel) || 0;
    adapter.config.concatWord     = (adapter.config.concatWord || '').toString().trim();
    adapter.config.apikey         = (adapter.config.apikey || '').trim();
    adapter.config.replaces       = adapter.config.replaces ? adapter.config.replaces.split(',') : null;
    adapter.config.cloudUrl       = (adapter.config.cloudUrl || '').toString();

    adapter.config.pass           = adapter.config.pass || '';
    adapter.config.login          = adapter.config.login || '';
    adapter.config.server         = adapter.config.server || 'iobroker.pro';

    if (adapter.config.login !== (adapter.config.login || '').trim().toLowerCase()) {
        adapter.log.error('Please write your login only in lowercase!');
    }

    let appKeyPromise

    if (adapter.config.login && adapter.config.pass) {
        appKeyPromise = readAppKeyFromCloud()
    } else {
        appKeyPromise = Promise.resolve(adapter.config.apikey);
    }

    appKeyPromise
        .then(_apikey => {
            apikey = _apikey;
            if (apikey && apikey.match(/^@pro_/)) {
                if (adapter.config.cloudUrl.indexOf('https://iobroker.pro:')  === -1 &&
                    adapter.config.cloudUrl.indexOf('https://iobroker.info:') === -1) {
                    adapter.config.cloudUrl = 'https://iobroker.pro:10555';
                }
            } else {
                adapter.config.allowAdmin = false;
            }

            if (adapter.config.replaces) {
                let text = [];
                for (let r = 0; r < adapter.config.replaces.length; r++) {
                    text.push(`"${adapter.config.replaces}"`);
                }
                adapter.log.debug(`Following strings will be replaced in names: ${text.join(', ')}`);
            }

            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

            adapter.config.allowedServices = (adapter.config.allowedServices || '').split(/[,\s]+/);
            for (let s = 0; s < adapter.config.allowedServices.length; s++) {
                adapter.config.allowedServices[s] = adapter.config.allowedServices[s].trim();
            }

            adapter.setState('info.connection', false, true);
            adapter.config.cloudUrl = adapter.config.cloudUrl || 'https://iobroker.net:10555';

            if (!apikey) {
                return adapter.log.error('No api-key found. Please get one on https://iobroker.net');
            }

            if (adapter.config.iftttKey) {
                adapter.subscribeStates('services.ifttt');
                // create ifttt object
                adapter.getObject('services.ifttt', (err, obj) => {
                    if (!obj) {
                        adapter.setObject('services.ifttt', {
                            _id: adapter.namespace + '.services.ifttt',
                            type: 'state',
                            common: {
                                name: 'IFTTT value',
                                write: true,
                                role: 'state',
                                read: true,
                                type: 'mixed',
                                desc: 'All written data will be sent to IFTTT. If no state specified all requests from IFTTT will be saved here'
                            },
                            native: {}
                        });
                    }
                });
            }

            adapter.subscribeStates('smart.*');

            adapter.log.info(`Connecting with ${adapter.config.cloudUrl} with "${apikey}"`);

            return adapter.getForeignObjectAsync('system.meta.uuid');
        })
        .then(obj => {
            if (obj && obj.native) {
                uuid = obj.native.uuid;
            }
            startConnect(true);
        })
        .catch(e => adapter.log.error(`Error: ${e}`));
}

// If started as allInOne/compact mode => return function to create instance
if (module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
