/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const SocketCloud = require('./lib/socketCloud.js');
const axios = require('axios');
const pack = require('./io-package.json');

let socket = null;
let ioSocket = null;

let pingTimer = null;
let connected = false;
let connectTimer = null;
let uuid = null;
let waiting = false;
let apikey = '';
let server = 'http://localhost:8082';
let adminServer = 'http://localhost:8081';
let lovelaceServer = 'http://localhost:8091';
let webSupportsConfig = false;

let TEXT_PING_TIMEOUT = 'Ping timeout';
let redirectRunning = false; // is redirect in progress

let timeouts = {
    terminate: null,
    onCloudWait: null,
    detectDisconnect: null,
    redirect: null,
    onCloudStop: null,
    createAppKey: null,
    readAppKey: null,
};

let adapter;
function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'cloud',
        objectChange: (id, obj) => {
            if (id === adapter.config.instance) {
                webSupportsConfig = obj.common.version.split('.')[0] >= '7';
                const _server = getConnectionString(obj, 'web');
                if (_server !== server) {
                    server = _server;
                    adapter.log.info(
                        `Reconnect because web instance ${obj && obj.common && obj.common.enabled ? 'started' : 'stopped'}`,
                    );
                    startConnect(true);
                }
            } else if (id === adapter.config.allowAdmin) {
                const _adminServer = getConnectionString(obj, 'admin');
                if (_adminServer !== adminServer) {
                    adminServer = _adminServer;
                    adapter.log.info(
                        `Reconnect because admin instance ${obj && obj.common && obj.common.enabled ? 'started' : 'stopped'}`,
                    );
                    startConnect(true);
                }
            } else if (id === adapter.config.lovelace) {
                const _lovelaceServer = getConnectionString(obj, 'lovelace');
                if (_lovelaceServer !== lovelaceServer) {
                    lovelaceServer = _lovelaceServer;
                    adapter.log.info(
                        `Reconnect because lovelace instance ${obj && obj.common && obj.common.enabled ? 'started' : 'stopped'}`,
                    );
                    startConnect(true);
                }
            }

            ioSocket && ioSocket.send(socket, 'objectChange', id, obj);
        },
        stateChange: (id, state) => {
            if (socket) {
                if (id === `${adapter.namespace}.services.ifttt` && state && !state.ack) {
                    sendDataToIFTTT({
                        id: id,
                        val: state.val,
                        ack: false,
                    });
                } else {
                    ioSocket && ioSocket.send(socket, 'stateChange', id, state);
                }
            }
        },
        unload: callback => {
            if (connectTimer) {
                clearInterval(connectTimer);
                connectTimer = null;
            }
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }

            Object.keys(timeouts).forEach(tm => {
                if (timeouts[tm]) {
                    clearTimeout(timeouts[tm]);
                    timeouts[tm] = null;
                }
            });

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

                    case 'getIFTTTLink':
                        if (typeof obj.message === 'string') {
                            return (
                                obj.callback && adapter.sendTo(obj.from, obj.command, 'invalid config', obj.callback)
                            );
                        }
                        if (obj.message.useCredentials) {
                            _readAppKeyFromCloud(
                                obj.message.server,
                                obj.message.login,
                                obj.message.pass,
                                (err, key) => {
                                    const text = `https://${obj.message.server}/ifttt/${key}`;
                                    obj.callback && adapter.sendTo(obj.from, obj.command, text, obj.callback);
                                },
                            );
                        } else {
                            const text = `https://${obj.message.apikey.startsWith('@pro_') ? 'iobroker.pro' : 'iobroker.net'}/ifttt/${obj.message.apikey}`;
                            obj.callback && adapter.sendTo(obj.from, obj.command, text, obj.callback);
                        }
                        break;

                    case 'getServiceLink':
                        if (typeof obj.message === 'string') {
                            return (
                                obj.callback && adapter.sendTo(obj.from, obj.command, 'invalid config', obj.callback)
                            );
                        }

                        if (obj.message.useCredentials) {
                            _readAppKeyFromCloud(
                                obj.message.server,
                                obj.message.login,
                                obj.message.pass,
                                (err, key) => {
                                    const text = `https://${obj.message.server}/service/custom_<NAME>/${key}/<data>`;
                                    obj.callback && adapter.sendTo(obj.from, obj.command, text, obj.callback);
                                },
                            );
                        } else {
                            const text = `https://${obj.message.apikey.startsWith('@pro_') ? 'iobroker.pro' : 'iobroker.net'}/service/custom_<NAME>/${obj.message.apikey}/<data>`;
                            obj.callback && adapter.sendTo(obj.from, obj.command, text, obj.callback);
                        }
                        break;

                    case 'cmdStdout':
                    case 'cmdStderr':
                    case 'cmdExit':
                    case 'getHostInfo':
                        // send it to the cloud
                        ioSocket && ioSocket.send(socket, obj.command, obj.message.id, obj.message.data);
                        break;

                    case 'tts': {
                        if (obj.callback) {
                            const params = {
                                text: typeof obj.message === 'object' ? obj.message.text : obj.message,
                                apiKey: apikey,
                                textType: obj.message.textType || 'text',
                                voiceId: obj.message.voiceId || 'Marlene',
                                engine: obj.message.engine,
                            };
                            axios
                                .post(`${adapter.config.cloudUrl.replace(/:(\d+)$/, ':3001')}/api/v1/polly`, params, {
                                    headers: {
                                        'Content-Type': 'application/json',
                                    },
                                    responseType: 'arraybuffer',
                                })
                                .then(response => {
                                    if (response.data) {
                                        const base64 = Buffer.from(response.data, 'binary').toString('base64');
                                        obj.callback && adapter.sendTo(obj.from, obj.command, { base64 }, obj.callback);
                                    } else {
                                        obj.callback &&
                                            adapter.sendTo(obj.from, obj.command, { error: 'no data' }, obj.callback);
                                    }
                                })
                                .catch(e =>
                                    adapter.sendTo(
                                        obj.from,
                                        obj.command,
                                        { error: (e.response && e.response.data) || e.toString() },
                                        obj.callback,
                                    ),
                                );
                        }
                        break;
                    }

                    default:
                        adapter.log.warn(`Unknown command_: ${obj.command}`);
                        break;
                }
            }
        },
        ready: () => createInstancesStates(main),
    });

    adapter = new utils.Adapter(options);

    adapter.on('log', obj => {
        if (apikey && apikey.startsWith('@pro_')) {
            ioSocket && ioSocket.send(socket, 'log', obj);
        }
    });

    return adapter;
}

function getConnectionString(obj, name) {
    let conn = null;
    if (obj?.common && obj.native) {
        if (obj.native.auth) {
            adapter.log.error(
                `Cannot activate ${obj._id.replace('system.adapter.', '')} for cloud, because authentication is enabled. Please create extra instance for cloud`,
            );
            return conn;
        } else if (obj.native.secure) {
            adapter.log.error(
                `Cannot activate ${obj._id.replace('system.adapter.', '')} for cloud, because HTTPs is enabled. Please create extra instance for cloud`,
            );
            return conn;
        } else if (!obj.common.enabled) {
            adapter.log.error(
                `Instance ${obj._id.replace('system.adapter.', '')} not enabled. Please enable this instance for cloud`,
            );
            return conn;
        } else {
            conn = `http${obj.native.secure ? 's' : ''}://`;
            // todo if run on other host
            conn += !obj.native.bind || obj.native.bind === '0.0.0.0' ? '127.0.0.1' : obj.native.bind;
            conn += `:${obj.native.port}`;
        }
    } else {
        conn = null;
        adapter.log.error(`Unknown instance for ${name} "${obj?._id || ''}"`);
    }
    return conn;
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
        ioSocket &&
            ioSocket.send(socket, 'ifttt', {
                id: `${adapter.namespace}.services.ifttt`,
                key: adapter.config.iftttKey,
                val: obj,
            });
    } else if (obj.event) {
        ioSocket &&
            ioSocket.send(socket, 'ifttt', {
                event: obj.event,
                key: obj.key || adapter.config.iftttKey,
                value1: obj.value1,
                value2: obj.value2,
                value3: obj.value3,
            });
    } else {
        if (obj.val === undefined) {
            adapter.log.warn('No value is defined');
            return;
        }
        obj.id = obj.id || `${adapter.namespace}.services.ifttt`;
        ioSocket &&
            ioSocket.send(socket, 'ifttt', {
                id: obj.id,
                key: obj.key || adapter.config.iftttKey,
                val: obj.val,
                ack: obj.ack,
            });
    }
}

function pingConnection() {
    if (!timeouts.detectDisconnect) {
        if (connected && ioSocket) {
            // cannot use "ping" because reserved by socket.io
            ioSocket.send(socket, 'pingg');

            timeouts.detectDisconnect = setTimeout(() => {
                timeouts.detectDisconnect = null;
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
        if (timeouts.detectDisconnect) {
            clearTimeout(timeouts.detectDisconnect);
            timeouts.detectDisconnect = null;
        }
    }
}

function controlState(id, data, callback) {
    id = id || 'services.ifttt';

    if (typeof data === 'object') {
        if (data.id) {
            if (data.id === `${adapter.namespace}.services.ifttt`) {
                data.ack = true;
            }
            if (data.val === undefined) {
                return callback && callback('No value set');
            }
            adapter.getForeignObject(data.id, (err, obj) => {
                if (!obj || !obj.common) {
                    callback && callback(`Unknown ID: ${data.id}`);
                } else {
                    if (typeof data.val === 'string') {
                        data.val = data.val.replace(/^@ifttt\s?/, '');
                    }
                    if (obj.common.type === 'boolean') {
                        data.val =
                            data.val === true ||
                            data.val === 'true' ||
                            data.val === 'on' ||
                            data.val === 'ON' ||
                            data.val === 1 ||
                            data.val === '1';
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
    adapter.log.debug(`Received IFTTT object: ${data}`);
    let id;
    if (typeof data === 'object' && data.id && data.data !== undefined) {
        id = data.id;
        if (typeof data.data === 'string' && data.data[0] === '{') {
            try {
                data = JSON.parse(data.data);
            } catch (e) {
                adapter.log.debug(`Cannot parse: ${data.data}`);
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
                adapter.log.debug(`Cannot parse: ${data}`);
            }
        }
    }

    if (id) {
        adapter.getForeignObject(id, (err, obj) => {
            if (obj) {
                controlState(id, data, callback);
            } else {
                adapter.getForeignObject(`${adapter.namespace}.services.${id}`, (err, obj) => {
                    if (!obj) {
                        // create state
                        adapter.setObject(
                            `services.${id}`,
                            {
                                type: 'state',
                                common: {
                                    name: 'IFTTT value',
                                    write: false,
                                    role: 'state',
                                    read: true,
                                    type: 'mixed',
                                    desc: 'Custom state',
                                },
                                native: {},
                            },
                            () => controlState(`${adapter.namespace}.services.${id}`, data, callback),
                        );
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
        !redirectRunning && adapter.log.info(`Connection changed: ${event}`);
    } else {
        adapter.log.info('Connection changed: disconnect');
    }

    if (connected) {
        !redirectRunning && adapter.log.info('Connection lost');
        connected = false;
        adapter.setState('info.connection', false, true);

        // clear ping timers
        checkPing();

        if (adapter.config.restartOnDisconnect && !redirectRunning) {
            adapter.log.info('Restart adapter by disconnect');
            // simulate scheduled restart
            timeouts.terminate = setTimeout(() => {
                timeouts.terminate = null;
                adapter.terminate ? adapter.terminate(-100) : process.exit(-100);
            }, 10000);
        } else {
            redirectRunning = false;
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
        adapter.log.debug('Connection not changed: was connected');
    }

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
}

function onCloudConnect(clientId) {
    adapter.log.info(`User accessed from cloud: ${clientId || ''}`);
    adapter.setState('info.userOnCloud', true, true);
}

function onCloudDisconnect(clientId, name) {
    adapter.log.info(`User disconnected from cloud: ${clientId || ''} ${name || ''}`);
    adapter.setState('info.userOnCloud', false, true);
}

function onCloudWait(seconds) {
    waiting = true;
    adapter.log.info(`Server asked to wait for ${seconds || 60} seconds`);
    if (socket) {
        socket.disconnect();
        socket.off();
        socket = null;
    }
    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }

    timeouts.onCloudWait = setTimeout(
        () => {
            timeouts.onCloudWait = null;
            waiting = false;
            startConnect(true);
        },
        seconds * 1000 || 60000,
    );
}

function onCloudRedirect(data) {
    if (!data) {
        adapter.log.info('Received invalid redirect command from server');
        return;
    }
    if (!data.url) {
        adapter.log.error('Received redirect, but no URL.');
    } else if (data.notSave) {
        redirectRunning = true;
        adapter.log.info(
            `Adapter redirected temporally to "${data.url}" ${adapter.config.cloudUrl.includes('https://iobroker.pro:') ? 'in 30 seconds' : 'in one minute'}. Reason: ${data && data.reason ? data.reason : 'command from server'}`,
        );
        adapter.config.cloudUrl = data.url;
        if (socket) {
            socket.disconnect();
            socket.off();
        }
        startConnect();
    } else {
        adapter.log.info(
            `Adapter redirected continuously to "${data.url}". Reason: ${data && data.reason ? data.reason : 'command from server'}`,
        );

        adapter.getForeignObject(`system.adapter.${adapter.namespace}`, (err, obj) => {
            err && adapter.log.error(`redirectAdapter [getForeignObject]: ${err}`);
            if (obj) {
                obj.native.cloudUrl = data.url;
                timeouts.redirect = setTimeout(() => {
                    timeouts.redirect = null;

                    adapter.setForeignObject(obj._id, obj, err => {
                        err && adapter.log.error(`redirectAdapter [setForeignObject]: ${err}`);

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
    adapter.log.error(`Cloud says: ${error}`);
}

function onCloudStop() {
    adapter.getForeignObject(`system.adapter.${adapter.namespace}`, (err, obj) => {
        err && adapter.log.error(`[onCloudStop]: ${err}`);
        if (obj) {
            obj.common.enabled = false;
            timeouts.onCloudStop = setTimeout(() => {
                timeouts.onCloudStop = null;
                adapter.setForeignObject(obj._id, obj, err => {
                    err && adapter.log.error(`[setForeignObject]: ${err}`);
                    adapter.terminate ? adapter.terminate() : process.exit();
                });
            }, 5000);
        } else {
            adapter.terminate ? adapter.terminate() : process.exit();
        }
    });
}

// this is bug of socket.io
// sometimes auto-reconnect does not work.
function startConnect(immediately) {
    if (waiting) {
        return;
    }

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
    connectTimer = setInterval(
        () => connect(),
        adapter.config.cloudUrl.includes('https://iobroker.pro:') ? 30000 : 60000,
    ); // on pro there are not so many users as on net.
    if (immediately) {
        connect();
    }
}

function initConnect(socket, options) {
    ioSocket = new SocketCloud(socket, options, adapter, lovelaceServer);

    ioSocket.on('connect', onConnect);
    ioSocket.on('disconnect', onDisconnect);
    ioSocket.on('cloudError', onCloudError);
    ioSocket.on('cloudConnect', onCloudConnect);
    ioSocket.on('cloudDisconnect', onCloudDisconnect);
    ioSocket.on('connectWait', onCloudWait);
    ioSocket.on('cloudRedirect', onCloudRedirect);
    ioSocket.on('cloudStop', onCloudStop);
}

function answerWithReason(instance, name, cb) {
    if (!instance) {
        adapter.log.error(`${name} instance not defined. Please specify the lovelace instance in settings`);
    } else {
        adapter
            .getForeignObjectAsync(instance)
            .catch(() => null)
            .then(obj => {
                const conn = getConnectionString(obj);
                if (conn) {
                    if (!obj.common.enabled) {
                        adapter.log.error(`${name} instance "${instance}" not activated.`);
                    } else {
                        adapter.log.error(`${name} instance "${instance}" not available.`);
                    }
                }
            });
    }
    cb && cb(`${name} is inactive`, 404, [], `${name} is inactive`);
}

async function connect() {
    if (waiting) {
        return;
    }
    if (adapter.config.allowAdmin) {
        const obj = await adapter.getForeignObjectAsync(adapter.config.allowAdmin).catch(() => null);
        if (obj) {
            adminServer = getConnectionString(obj, 'admin');
        }
    }
    if (adapter.config.lovelace) {
        const obj = await adapter.getForeignObjectAsync(adapter.config.lovelace).catch(() => null);
        if (obj) {
            lovelaceServer = getConnectionString(obj, 'lovelace');
        }
    }
    if (adapter.config.instance) {
        const obj = await adapter.getForeignObjectAsync(adapter.config.instance).catch(() => null);
        if (obj) {
            webSupportsConfig = obj.common.version.split('.')[0] >= '7';
            server = getConnectionString(obj, 'web');
        }
    }

    adapter.log.debug(`Connection attempt to ${adapter.config.cloudUrl} ...`);

    if (socket) {
        socket.off();
        socket.disconnect();
    }

    socket = require('socket.io-client')(adapter.config.cloudUrl, {
        transports: ['websocket'],
        autoConnect: true,
        reconnection: !adapter.config.restartOnDisconnect,
        rejectUnauthorized: !adapter.config.allowSelfSignedCertificate,
        randomizationFactor: 0.9,
        reconnectionDelay: 60000,
        timeout: parseInt(adapter.config.connectionTimeout, 10) || 10000,
        reconnectionDelayMax: 120000,
    });

    if (server || lovelaceServer || adminServer) {
        initConnect(socket, {
            apikey,
            uuid,
            version: pack.common.version,
            allowAdmin: adapter.config.allowAdmin,
            lovelace: adapter.config.lovelace,
        });
    }

    socket.on('connect_error', error => adapter.log.error(`Error while connecting to cloud: ${error}`));

    // cannot use "pong" because reserved by socket.io
    socket.on('pongg', (/*error*/) => {
        clearTimeout(timeouts.detectDisconnect);
        timeouts.detectDisconnect = null;
    });

    socket.on('method', (url, options, cb) => {
        if (url.startsWith('/lovelace/')) {
            url = url.replace(/^\/lovelace\//, '/');
            if (!lovelaceServer) {
                answerWithReason(adapter.config.lovelace, 'Lovelace', cb);
            } else {
                axios({
                    url: lovelaceServer + url,
                    method: options.method,
                    data: options.body,
                    // responseType: 'arraybuffer',
                    validateStatus: status => status < 400,
                })
                    .then(response => cb(null, response.status, response.headers, JSON.stringify(response.data)))
                    .catch(error => {
                        if (error.response) {
                            adapter.log.error(
                                `Cannot request lovelace pages "${url}": ${error.response.data || error.response.status}`,
                            );
                            cb(
                                error.response.data || error.response.status,
                                error.response.status || 501,
                                error.response.headers,
                                JSON.stringify(error.response.data),
                            );
                        } else {
                            adapter.log.error(`Cannot request lovelace pages "${url}": ${error.code}`);
                            cb(error.code, 501, {}, JSON.stringify({ error: 'unexpected error' }));
                        }
                    });
            }
        } else {
            adapter.log.error(`Unexpected request: ${url}`);

            if (!server) {
                answerWithReason(adapter.config.instance, 'Web', cb);
            } else {
                axios({
                    url: server + url,
                    method: options.method,
                    data: options.body,
                    // responseType: 'arraybuffer',
                    validateStatus: status => status < 400,
                })
                    .then(response => cb(null, response.status, response.headers, JSON.stringify(response.data)))
                    .catch(error => {
                        if (error.response) {
                            adapter.log.error(
                                `Cannot request web pages "${server}${url}": ${error.response.data || error.response.status}`,
                            );
                            cb(
                                error.response.data || error.response.status,
                                error.response.status || 501,
                                error.response.headers,
                                JSON.stringify(error.response.data),
                            );
                        } else {
                            adapter.log.error(`Cannot request web pages "${server}${url}": ${error.code}`);
                            cb(error.code, 501, {}, JSON.stringify({ error: 'unexpected error' }));
                        }
                    });
            }
        }
    });

    socket.on('html', (url, cb) => {
        try {
            if (url.match(/^\/admin\//)) {
                if (adminServer && adapter.config.allowAdmin) {
                    url = url.substring(6);
                    if (url.includes('loginBackgroundImage')) {
                        console.log('AAA');
                    }
                    if (url === '/@@loginBackgroundImage@@') {
                        url = '/files/admin.0/login-bg.png';
                    }

                    axios
                        .get(adminServer + url, { responseType: 'arraybuffer', validateStatus: status => status < 400 })
                        .then(response => cb(null, response.status, response.headers, response.data))
                        .catch(error => {
                            if (error.response) {
                                adapter.log.error(
                                    'Cannot request admin pages: ' + (error.response.data || error.response.status),
                                );
                                cb(
                                    error.code,
                                    error.response.status || 501,
                                    error.response.headers,
                                    error.response.data,
                                );
                            } else {
                                adapter.log.error('Cannot request admin pages: no response');
                                cb('no response', 501, {}, 'no response from admin');
                            }
                        });
                } else {
                    answerWithReason(adapter.config.allowAdmin, 'Admin');

                    cb(
                        'Enable admin in cloud settings. And only pro.',
                        404,
                        [],
                        'Enable admin in cloud settings. And only pro.',
                    );
                }
            } else if (
                url.startsWith('/adapter/') ||
                url.startsWith('/lib/js/ace-') ||
                url.startsWith('/lib/js/cron') ||
                url.startsWith('/lib/js/jqGrid')
            ) {
                // if admin
                if (adminServer && adapter.config.allowAdmin) {
                    axios
                        .get(adminServer + url, { responseType: 'arraybuffer', validateStatus: status => status < 400 })
                        .then(response => cb(null, response.status, response.headers, response.data))
                        .catch(error => {
                            if (error.response) {
                                adapter.log.error(
                                    `Cannot request admin pages: ${error.response.data || error.response.status}`,
                                );
                                cb(
                                    error.code,
                                    error.response.status || 501,
                                    error.response.headers,
                                    error.response.data,
                                );
                            } else {
                                adapter.log.error('Cannot request admin pages: no response');
                                cb('no response', 501, {}, 'no response from admin');
                            }
                        });
                } else {
                    answerWithReason(adapter.config.allowAdmin, 'Admin');

                    cb(
                        'Enable admin in cloud settings. And only pro.',
                        404,
                        [],
                        'Enable admin in cloud settings. And only pro.',
                    );
                }
            } else if (url.startsWith('/lovelace/')) {
                // if lovelace
                if (lovelaceServer && adapter.config.lovelace) {
                    url = url.replace(/^\/lovelace\//, '/');
                    axios
                        .get(lovelaceServer + url, {
                            responseType: 'arraybuffer',
                            validateStatus: status => status < 400,
                        })
                        .then(response => cb(null, response.status, response.headers, response.data))
                        .catch(error => {
                            if (error.response) {
                                adapter.log.error(
                                    `Cannot request lovelace pages "${lovelaceServer + url}": ${error.response.data || error.response.status}`,
                                );
                                cb(
                                    error.code,
                                    error.response.status || 501,
                                    error.response.headers,
                                    error.response.data,
                                );
                            } else {
                                adapter.log.error(
                                    `Cannot request lovelace pages "${lovelaceServer + url}": no response`,
                                );
                                cb('no response', 501, {}, 'no response from lovelace');
                            }
                        });
                } else {
                    answerWithReason(adapter.config.lovelace, 'Lovelace', cb);
                }
            } else if (server) {
                if (url === '/') {
                    // cloud wants to know the list of possible instances
                    if (webSupportsConfig) {
                        axios
                            .get(`${server}/config.json`, {
                                responseType: 'arraybuffer',
                                validateStatus: status => status < 400,
                            })
                            .then(response => cb(null, response.status, response.headers, response.data))
                            .catch(error => {
                                if (error.response) {
                                    adapter.log.error(
                                        `Cannot request web pages "${server + url}": ${error.response.data || error.response.status}`,
                                    );
                                    cb(
                                        error.code,
                                        error.response.status || 501,
                                        error.response.headers,
                                        error.response.data,
                                    );
                                } else {
                                    adapter.log.error(`Cannot request web pages"${server + url}": no response`);
                                    cb('no response', 501, {}, 'no response from web');
                                }
                            });
                        return;
                    }
                }
                // web
                axios
                    .get(server + url, { responseType: 'arraybuffer', validateStatus: status => status < 400 })
                    .then(response => cb(null, response.status, response.headers, response.data))
                    .catch(error => {
                        if (error.response) {
                            adapter.log.error(
                                `Cannot request web pages "${server + url}": ${error.response.data || error.response.status}`,
                            );
                            cb(
                                error.code,
                                error.response.status || 501,
                                error.response.headers,
                                error.response.data,
                            );
                        } else {
                            adapter.log.error(`Cannot request web pages"${server + url}": no response`);
                            cb('no response', 501, {}, 'no response from web');
                        }
                    });
            } else {
                // analyse answer
                return answerWithReason(adapter.config.instance, 'Web', cb);
            }
        } catch (e) {
            adapter.log.error(`Cannot request: ${e}`);
            cb('Admin or Web are inactive.', 404, {}, 'Admin or Web are inactive.');
        }
    });

    socket.on('ifttt', processIfttt);

    socket.on('iftttError', error => adapter.log.error(`Error from IFTTT: ${JSON.stringify(error)}`));

    socket.on('cloudError', error => adapter.log.error(`Cloud says: ${error}`));

    socket.on('service', (data, callback) => {
        adapter.log.debug('service: ' + JSON.stringify(data));
        // supported services:
        // - text2command
        // - simpleApi
        // - custom, e.g. torque
        if (!data || !data.name) {
            callback && callback({ error: 'no name' });
        } else if (data.name === 'ifttt' && adapter.config.iftttKey) {
            processIfttt(data.data, callback);
        } else {
            let isCustom = false;
            if (data.name.match(/^custom_/)) {
                data.name = data.name.substring(7);
                isCustom = true;
            }

            if (adapter.config.allowedServices[0] === '*' || adapter.config.allowedServices.includes(data.name)) {
                if (!isCustom && data.name === 'text2command') {
                    if (adapter.config.text2command !== undefined && adapter.config.text2command !== '') {
                        adapter.setForeignState(
                            `text2command.${adapter.config.text2command}.text`,
                            decodeURIComponent(data.data),
                            err => callback && callback({ result: err || 'Ok' }),
                        );
                    } else {
                        adapter.log.warn('Received service text2command, but instance is not defined');
                        callback && callback({ error: 'instance is not defined' });
                    }
                } else if (!isCustom && (data.name === 'simpleApi' || data.name === 'simpleapi')) {
                    // GET https://iobroker.net/service/simpleApi/<user-app-key>/get/system.adapter.admin.0.cputime
                    const parts = (data.data || '').split('/');
                    if (parts[0] === 'get') {
                        adapter.getForeignState(parts[1], (error, state) => {
                            if (error) {
                                callback && callback({ error });
                            } else if (state) {
                                state.result = 'Ok';
                                callback && callback(state);
                            } else {
                                callback && callback({ result: 'Not found' });
                            }
                        });
                    } else if (parts[0] === 'getPlainValue') {
                        adapter.getForeignState(parts[1], (error, state) => {
                            if (error) {
                                callback && callback({ error });
                            } else if (state) {
                                callback && callback({ result: 'Ok', val: state.val, plain: true });
                            } else {
                                callback && callback({ result: 'Not found', val: null, plain: true });
                            }
                        });
                    } else if (parts[0] === 'set') {
                        // https://iobroker.pro/service/simpleapi/<user-app-key>/set/stateID?value=1
                        let [id, val] = parts[1].split('?');
                        if (id === undefined || val === undefined) {
                            return callback && callback({ error: 'invalid call' });
                        }
                        val = val.replace(/^value=/, '');
                        adapter.getForeignObject(id, (error, obj) => {
                            if (error || !obj) {
                                callback && callback({ error: error || 'not found' });
                            } else if (obj.type !== 'state') {
                                callback && callback({ error: 'only states can be controlled' });
                            } else {
                                if (obj.common && obj.common.type === 'boolean') {
                                    val = val === 'true' || val === '1' || val === 'ON' || val === 'on';
                                } else if (obj.common && obj.common.type === 'number') {
                                    val = parseFloat(val);
                                }
                                adapter.setForeignState(id, val, error => {
                                    if (error) {
                                        callback && callback({ error });
                                    } else {
                                        callback && callback({ result: 'Ok' });
                                    }
                                });
                            }
                        });
                    } else {
                        callback && callback({ error: 'not implemented' });
                    }
                } else if (isCustom) {
                    adapter.getObject(`services.custom_${data.name}`, (err, obj) => {
                        if (!obj) {
                            adapter.setObject(
                                `services.custom_${data.name}`,
                                {
                                    _id: `${adapter.namespace}.services.custom_${data.name}`,
                                    type: 'state',
                                    common: {
                                        name: `Service for ${data.name}`,
                                        write: false,
                                        read: true,
                                        type: 'mixed',
                                        role: 'value',
                                    },
                                    native: {},
                                },
                                err => {
                                    if (!err) {
                                        adapter.setState(
                                            `services.custom_${data.name}`,
                                            data.data,
                                            false,
                                            err => callback && callback({ result: err || 'Ok' }),
                                        );
                                    } else {
                                        callback && callback({ result: err });
                                    }
                                },
                            );
                        } else {
                            adapter.setState(
                                `services.custom_${data.name}`,
                                data.data,
                                false,
                                err => callback && callback({ result: err || 'Ok' }),
                            );
                        }
                    });
                } else {
                    callback && callback({ error: 'not allowed' });
                }
            } else {
                adapter.log.warn(`Received service "${data.name}", but it is not found in whitelist`);
                callback && callback({ error: 'blocked' });
            }
        }
    });

    socket.on('error', error => {
        console.error(`Some error: ${error}`);
        startConnect();
    });
}

function createInstancesStates(callback, objs) {
    if (!objs) {
        const pack = require('./io-package.json');
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
    adapter.log.info('Create new APP-KEY...');
    const url = `https://${adapter.config.server}:3001/api/v1/appkeys`;

    axios
        .post(url, null, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${adapter.config.login}:${adapter.config.pass}`).toString('base64')}`,
            },
            validateStatus: status => status < 400,
        })
        .then(response => {
            let body = response.data;

            if (body && body.key && body.key[0]) {
                adapter.log.info(`New APP-KEY is ${body.key[0]}`);
                cb(null, body.key[0]);
            } else {
                cb(`Cannot create app-key on server "${url}": ${JSON.stringify(body)}`);
            }
        })
        .catch(error => {
            if (error.code === 'ECONNREFUSED') {
                adapter.log.warn('Server is offline or no connection. Retry in 10 seconds');
                timeouts.createAppKey = setTimeout(() => {
                    timeouts.createAppKey = null;
                    _createAppKey(cb);
                }, 10000);
            } else if (error.response && error.response.status === 401) {
                return cb(
                    `Invalid user name or password or server (may be it is ${adapter.config.server === 'iobroker.pro' ? 'iobroker.net' : 'iobroker.pro'})`,
                );
            } else if (error.response && error.response.data) {
                let body = error.response.data;

                if (body && body.key && body.key[0]) {
                    adapter.log.info(`New APP-KEY is ${body.key[0]}`);
                    cb(null, body.key[0]);
                } else {
                    cb(
                        `Cannot create app-key on server "${url}": ${
                            (error.response && error.response.status) ||
                            (error.response && error.response.data && JSON.stringify(error.response.data)) ||
                            'unknown error'
                        }`,
                    );
                }
            } else {
                cb(`Cannot create app-key on server "${url}": ${error.code || 'unknown error'}`);
            }
        });
}

function _readAppKeyFromCloud(server, login, password, cb) {
    if (typeof server === 'function') {
        cb = server;
        server = null;
    }
    server = server || adapter.config.server;
    login = login || adapter.config.login;
    password = password || adapter.config.pass;

    if (!server.length) {
        return cb('Servername not provided. Please check your configuration!');
    }
    if (!login.length) {
        return cb('Login not provided. Please check your configuration!');
    }
    if (!password.length) {
        return cb('Password not provided. Please check your configuration!');
    }

    const url = `https://${server}:3001/api/v1/appkeys`;

    axios
        .get(url, {
            headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}` },
            validateStatus: status => status < 400,
        })
        .then(response => {
            let body = response.data;

            if (body && body[0] && body[0].key) {
                cb(null, body[0].key);
            } else if (body) {
                _createAppKey(cb);
            } else {
                // todo: create key
                cb(`Cannot create app-key on server "${url}": ${body ? JSON.stringify(body) : 'key does not exist'}`);
            }
        })
        .catch(error => {
            if (error.code === 'ECONNREFUSED') {
                adapter.log.warn('Server is offline or no connection. Retry in 10 seconds');

                timeouts.readAppKey = setTimeout(() => {
                    timeouts.readAppKey = null;
                    _readAppKeyFromCloud(server, login, password, cb);
                }, 10000);
            } else if (error.response && error.response.status === 401) {
                return cb(
                    `Invalid user name or password or server (may be it is ${adapter.config.server === 'iobroker.pro' ? 'iobroker.net' : 'iobroker.pro'})`,
                );
            } else if (error.response && error.response.data) {
                let body = error.response.data;

                if (body && body[0] && body[0].key) {
                    adapter.log.info(`New APP-KEY is ${body[0].key}`);
                    cb(null, body[0].key);
                } else {
                    cb(
                        `Cannot create app-key on server "${url}": ${
                            (error.response && error.response.status) ||
                            (error.response && error.response.data && JSON.stringify(error.response.data)) ||
                            'unknown error'
                        }`,
                    );
                }
            } else {
                cb(`Cannot create app-key on server "${url}": ${error.code || 'unknown error'}`);
            }
        });
}

function readAppKeyFromCloud(_resolve, _reject) {
    if (!_resolve) {
        return new Promise((resolve, reject) => readAppKeyFromCloud(resolve, reject));
    } else {
        _readAppKeyFromCloud((err, key) => (err ? _reject(err) : _resolve(key)));
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
    adapter.config.concatWord = (adapter.config.concatWord || '').toString().trim();
    adapter.config.apikey = (adapter.config.apikey || '').trim();
    adapter.config.replaces = adapter.config.replaces ? adapter.config.replaces.split(',') : null;
    adapter.config.cloudUrl = (adapter.config.cloudUrl || '').toString();

    adapter.config.pass = adapter.config.pass || '';
    adapter.config.login = adapter.config.login || '';
    adapter.config.server = adapter.config.server || 'iobroker.pro';

    if (adapter.config.login !== (adapter.config.login || '').trim().toLowerCase()) {
        adapter.log.error('Please write your login only in lowercase!');
    }

    let appKeyPromise;

    if (adapter.config.login && adapter.config.pass && adapter.config.useCredentials) {
        if (adapter.config.server === 'iobroker.pro') {
            adapter.config.cloudUrl = adapter.config.cloudUrl.replace('iobroker.net', 'iobroker.pro');
        } else if (adapter.config.server === 'iobroker.net') {
            adapter.config.cloudUrl = adapter.config.cloudUrl.replace('iobroker.pro', 'iobroker.net');
        }

        appKeyPromise = readAppKeyFromCloud();
    } else {
        appKeyPromise = Promise.resolve(adapter.config.apikey);
    }

    appKeyPromise
        .then(_apikey => {
            apikey = _apikey;
            if (apikey?.startsWith('@pro_')) {
                // if (
                //     !adapter.config.cloudUrl.startsWith('https://iobroker.pro:') &&
                //     !adapter.config.cloudUrl.startsWith('https://iobroker.info:')
                // ) {
                //     // yes .info and not .net (was debug server somewhere)
                //     adapter.config.cloudUrl = 'https://iobroker.pro:10555';
                // }
            } else {
                adapter.config.allowAdmin = false;
                adapter.config.lovelace = false;
            }

            if (adapter.config.replaces) {
                let text = [];
                for (let r = 0; r < adapter.config.replaces.length; r++) {
                    text.push(`"${adapter.config.replaces}"`);
                }
                adapter.log.debug(`Following strings will be replaced in names: ${text.join(', ')}`);
            }

            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

            if (typeof adapter.config.allowedServices === 'string') {
                adapter.config.allowedServices = (adapter.config.allowedServices || '').split(/[,\s]+/);
            } else if (!Array.isArray(adapter.config.allowedServices)) {
                adapter.config.allowedServices = [];
            }
            adapter.config.allowedServices = adapter.config.allowedServices.map(s => s.trim());

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
                            _id: `${adapter.namespace}.services.ifttt`,
                            type: 'state',
                            common: {
                                name: 'IFTTT value',
                                write: true,
                                role: 'state',
                                read: true,
                                type: 'mixed',
                                desc: 'All written data will be sent to IFTTT. If no state specified all requests from IFTTT will be saved here',
                            },
                            native: {},
                        });
                    }
                });
            }

            if (adapter.config.instance && !adapter.config.instance.startsWith('system.adapter.')) {
                adapter.config.instance = `system.adapter.${adapter.config.instance}`;
            }
            if (adapter.config.allowAdmin && !adapter.config.allowAdmin.startsWith('system.adapter.')) {
                adapter.config.allowAdmin = `system.adapter.${adapter.config.allowAdmin}`;
            }
            if (adapter.config.lovelace && !adapter.config.lovelace.startsWith('system.adapter.')) {
                adapter.config.lovelace = `system.adapter.${adapter.config.lovelace}`;
            }

            adapter.subscribeStates('smart.*');
            adapter.config.instance &&
                adapter.subscribeForeignObjects(
                    adapter.config.instance,
                    err => err && adapter.log.error(`Cannot subscribe: ${err}`),
                );
            adapter.config.allowAdmin &&
                adapter.subscribeForeignObjects(
                    adapter.config.allowAdmin,
                    err => err && adapter.log.error(`Cannot subscribe: ${err}`),
                );
            adapter.config.lovelace &&
                adapter.subscribeForeignObjects(
                    adapter.config.lovelace,
                    err => err && adapter.log.error(`Cannot subscribe: ${err}`),
                );

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
