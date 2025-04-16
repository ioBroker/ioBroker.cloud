"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudAdapter = void 0;
const adapter_core_1 = require("@iobroker/adapter-core"); // Get common this utils
const socketCloud_1 = __importDefault(require("./lib/socketCloud"));
const axios_1 = __importDefault(require("axios"));
const socket_io_client_1 = __importDefault(require("socket.io-client"));
const TEXT_PING_TIMEOUT = 'Ping timeout';
class CloudAdapter extends adapter_core_1.Adapter {
    redirectRunning = false; // is redirect in progress
    socket = null;
    ioSocket = null;
    pingTimer = null;
    cloudConnected = false;
    connectTimer = null;
    uuid = null;
    waiting = false;
    apikey = '';
    server = 'http://localhost:8082';
    adminServer = 'http://localhost:8081';
    lovelaceServer = 'http://localhost:8091';
    webSupportsConfig = false;
    timeouts = {
        terminate: null,
        onCloudWait: null,
        detectDisconnect: null,
        redirect: null,
        onCloudStop: null,
        createAppKey: null,
        readAppKey: null,
    };
    constructor(options = {}) {
        super({
            ...options,
            name: 'cloud',
            unload: callback => this.onUnload(callback),
            message: obj => this.onMessage(obj),
            stateChange: (id, state) => this.onStateChange(id, state),
            ready: () => this.main(),
            objectChange: (id, obj) => this.onObjectChange(id, obj),
        });
        this.on('log', obj => {
            if (this.apikey?.startsWith('@pro_')) {
                this.ioSocket?.send(this.socket, 'log', obj);
            }
        });
    }
    onUnload(callback) {
        if (this.connectTimer) {
            clearInterval(this.connectTimer);
            this.connectTimer = null;
        }
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        Object.keys(this.timeouts).forEach(tm => {
            if (this.timeouts[tm]) {
                clearTimeout(this.timeouts[tm]);
                this.timeouts[tm] = null;
            }
        });
        try {
            this.socket?.close();
            this.ioSocket = null;
        }
        catch {
            // ignore
        }
        callback();
    }
    onObjectChange(id, obj) {
        if (id === this.config.instance) {
            this.webSupportsConfig = obj?.common.version.split('.')[0] >= '7';
            const _server = this.getConnectionString(obj, 'web');
            if (_server !== this.server) {
                this.server = _server;
                this.log.info(`Reconnect because web instance ${obj?.common?.enabled ? 'started' : 'stopped'}`);
                this.startConnect(true);
            }
        }
        else if (id === this.config.allowAdmin) {
            const _adminServer = this.getConnectionString(obj, 'admin');
            if (_adminServer !== this.adminServer) {
                this.adminServer = _adminServer;
                this.log.info(`Reconnect because admin instance ${obj?.common?.enabled ? 'started' : 'stopped'}`);
                this.startConnect(true);
            }
        }
        else if (id === this.config.lovelace) {
            const _lovelaceServer = this.getConnectionString(obj, 'lovelace');
            if (_lovelaceServer !== this.lovelaceServer) {
                this.lovelaceServer = _lovelaceServer;
                this.log.info(`Reconnect because lovelace instance ${obj?.common?.enabled ? 'started' : 'stopped'}`);
                this.startConnect(true);
            }
        }
        this.ioSocket?.send(this.socket, 'objectChange', id, obj);
    }
    onStateChange(id, state) {
        if (this.socket) {
            if (id === `${this.namespace}.services.ifttt` && state && !state.ack) {
                this.sendDataToIFTTT({
                    id: id,
                    val: state.val,
                    ack: false,
                });
            }
            else {
                this.ioSocket?.send(this.socket, 'stateChange', id, state);
            }
        }
    }
    onMessage(obj) {
        if (obj) {
            switch (obj.command) {
                case 'ifttt':
                    this.sendDataToIFTTT(obj.message);
                    break;
                case 'getIFTTTLink':
                    if (typeof obj.message === 'string') {
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, 'invalid config', obj.callback);
                        }
                        return;
                    }
                    if (obj.message.useCredentials) {
                        this._readAppKeyFromCloud(obj.message.server, obj.message.login, obj.message.pass, (err, key) => {
                            const text = `https://${obj.message.server}/ifttt/${key}`;
                            if (obj.callback) {
                                this.sendTo(obj.from, obj.command, text, obj.callback);
                            }
                        });
                    }
                    else {
                        const text = `https://${obj.message.apikey.startsWith('@pro_') ? 'iobroker.pro' : 'iobroker.net'}/ifttt/${obj.message.apikey}`;
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, text, obj.callback);
                        }
                    }
                    break;
                case 'getServiceLink':
                    if (typeof obj.message === 'string') {
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, 'invalid config', obj.callback);
                        }
                        return;
                    }
                    if (obj.message.useCredentials) {
                        this._readAppKeyFromCloud(obj.message.server, obj.message.login, obj.message.pass, (err, key) => {
                            const text = `https://${obj.message.server}/service/custom_<NAME>/${key}/<data>`;
                            if (obj.callback) {
                                this.sendTo(obj.from, obj.command, text, obj.callback);
                            }
                        });
                    }
                    else {
                        const text = `https://${obj.message.apikey.startsWith('@pro_') ? 'iobroker.pro' : 'iobroker.net'}/service/custom_<NAME>/${obj.message.apikey}/<data>`;
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, text, obj.callback);
                        }
                    }
                    break;
                case 'cmdStdout':
                case 'cmdStderr':
                case 'cmdExit':
                case 'getHostInfo':
                    // send it to the cloud
                    this.ioSocket?.send(this.socket, obj.command, obj.message.id, obj.message.data);
                    break;
                case 'tts': {
                    if (obj.callback) {
                        const params = {
                            text: typeof obj.message === 'object' ? obj.message.text : obj.message,
                            apiKey: this.apikey,
                            textType: obj.message.textType || 'text',
                            voiceId: obj.message.voiceId || 'Marlene',
                            engine: obj.message.engine,
                        };
                        axios_1.default
                            .post(`${this.config.cloudUrl.replace(/:(\d+)$/, ':3001')}/api/v1/polly`, params, {
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            responseType: 'arraybuffer',
                        })
                            .then(response => {
                            if (obj.callback) {
                                if (response.data) {
                                    const base64 = Buffer.from(response.data, 'binary').toString('base64');
                                    this.sendTo(obj.from, obj.command, { base64 }, obj.callback);
                                }
                                else {
                                    this.sendTo(obj.from, obj.command, { error: 'no data' }, obj.callback);
                                }
                            }
                        })
                            .catch(e => {
                            if (obj.callback) {
                                this.sendTo(obj.from, obj.command, { error: (e.response && e.response.data) || e.toString() }, obj.callback);
                            }
                        });
                    }
                    break;
                }
                default:
                    this.log.warn(`Unknown command_: ${obj.command}`);
                    break;
            }
        }
    }
    getConnectionString(obj, name) {
        let conn = null;
        if (obj?.common && obj.native) {
            if (obj.native.auth) {
                this.log.error(`Cannot activate ${obj._id.replace('system.adapter.', '')} for cloud, because authentication is enabled. Please create extra instance for cloud`);
                return conn;
            }
            else if (obj.native.secure) {
                this.log.error(`Cannot activate ${obj._id.replace('system.adapter.', '')} for cloud, because HTTPs is enabled. Please create extra instance for cloud`);
                return conn;
            }
            else if (!obj.common.enabled) {
                this.log.error(`Instance ${obj._id.replace('system.adapter.', '')} not enabled. Please enable adapter instance for cloud`);
                return conn;
            }
            conn = `http${obj.native.secure ? 's' : ''}://`;
            // todo if run on other host
            conn += !obj.native.bind || obj.native.bind === '0.0.0.0' ? '127.0.0.1' : obj.native.bind;
            conn += `:${obj.native.port}`;
        }
        else {
            conn = null;
            this.log.error(`Unknown instance for ${name} "${obj?._id || ''}"`);
        }
        return conn;
    }
    sendDataToIFTTT(obj) {
        if (!obj) {
            this.log.warn('No data to send to IFTTT');
            return;
        }
        if (!this.config.iftttKey && (typeof obj !== 'object' || !obj.key)) {
            this.log.warn('No IFTTT key is defined');
            return;
        }
        if (typeof obj !== 'object') {
            this.ioSocket?.send(this.socket, 'ifttt', {
                id: `${this.namespace}.services.ifttt`,
                key: this.config.iftttKey,
                val: obj,
            });
        }
        else if (obj.event) {
            const event = obj;
            this.ioSocket?.send(this.socket, 'ifttt', {
                event: event.event,
                key: event.key || this.config.iftttKey,
                value1: event.value1,
                value2: event.value2,
                value3: event.value3,
            });
        }
        else {
            const event = obj;
            if (event.val === undefined) {
                this.log.warn('No value is defined');
                return;
            }
            event.id ||= `${this.namespace}.services.ifttt`;
            this.ioSocket?.send(this.socket, 'ifttt', {
                id: event.id,
                key: event.key || this.config.iftttKey,
                val: event.val,
                ack: event.ack,
            });
        }
    }
    pingConnection = () => {
        if (!this.timeouts.detectDisconnect) {
            if (this.cloudConnected && this.ioSocket) {
                // cannot use "ping" because reserved by socket.io
                this.ioSocket.send(this.socket, 'pingg');
                this.timeouts.detectDisconnect = setTimeout(() => {
                    this.timeouts.detectDisconnect = null;
                    this.log.error(TEXT_PING_TIMEOUT);
                    this.onDisconnect(TEXT_PING_TIMEOUT);
                }, this.config.pingTimeout);
            }
        }
    };
    checkPing() {
        if (this.cloudConnected) {
            this.pingTimer ||= setInterval(this.pingConnection, 30000);
        }
        else {
            if (this.pingTimer) {
                clearInterval(this.pingTimer);
                this.pingTimer = null;
            }
            if (this.timeouts.detectDisconnect) {
                clearTimeout(this.timeouts.detectDisconnect);
                this.timeouts.detectDisconnect = null;
            }
        }
    }
    async controlState(id, data) {
        id ||= 'services.ifttt';
        if (typeof data === 'object') {
            if (data.id) {
                if (data.id === `${this.namespace}.services.ifttt`) {
                    data.ack = true;
                }
                if (data.val === undefined) {
                    throw new Error('No value set');
                }
                const obj = (await this.getForeignObjectAsync(data.id));
                if (!obj?.common) {
                    throw new Error(`Unknown ID: ${data.id}`);
                }
                else {
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
                    }
                    else if (obj.common.type === 'number') {
                        data.val = parseFloat(data.val);
                    }
                    await this.setForeignStateAsync(data.id, data.val, data.ack);
                }
            }
            else if (data.val !== undefined) {
                if (typeof data.val === 'string') {
                    data.val = data.val.replace(/^@ifttt\s?/, '');
                }
                await this.setStateAsync(id, data.val, data.ack !== undefined ? data.ack : true);
            }
            else {
                await this.setStateAsync(id, JSON.stringify(data), true);
            }
        }
        else {
            if (typeof data === 'string') {
                data = data.replace(/^@ifttt\s?/, '');
            }
            await this.setStateAsync(id, data, true);
        }
    }
    async processIfttt(data) {
        this.log.debug(`Received IFTTT object: ${JSON.stringify(data)}`);
        let id;
        let dataObj;
        if (typeof data === 'object' && data.id && data.data !== undefined) {
            id = data.id;
            if (typeof data.data === 'string' && data.data[0] === '{') {
                try {
                    dataObj = JSON.parse(data.data);
                }
                catch {
                    this.log.debug(`Cannot parse: ${data.data}`);
                }
            }
            else {
                dataObj = data.data;
            }
        }
        else if (typeof data === 'string' && data[0] === '{') {
            try {
                data = JSON.parse(data);
                if (typeof data.id === 'string') {
                    id = data.id;
                    if (data.data) {
                        dataObj = data.data;
                    }
                    else {
                        dataObj = data;
                    }
                }
                else {
                    dataObj = data;
                }
            }
            catch {
                this.log.debug(`Cannot parse: ${JSON.stringify(data)}`);
                dataObj = data;
            }
        }
        if (dataObj === undefined) {
            dataObj = data;
        }
        if (id) {
            let obj = await this.getForeignObjectAsync(id);
            if (obj) {
                await this.controlState(id, dataObj);
            }
            else {
                obj = await this.getForeignObjectAsync(`${this.namespace}.services.${id}`);
                if (!obj) {
                    // create state
                    await this.setObjectAsync(`services.${id}`, {
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
                    });
                    await this.controlState(`${this.namespace}.services.${id}`, dataObj);
                }
                else {
                    await this.controlState(obj._id, dataObj);
                }
            }
        }
        else {
            await this.controlState(undefined, dataObj);
        }
    }
    onDisconnect = (event) => {
        if (typeof event === 'string') {
            if (!this.redirectRunning) {
                this.log.info(`Connection changed: ${event}`);
            }
        }
        else {
            this.log.info('Connection changed: disconnect');
        }
        if (this.cloudConnected) {
            if (!this.redirectRunning) {
                this.log.info('Connection lost');
            }
            this.cloudConnected = false;
            void this.setState('info.connection', false, true);
            // clear ping timers
            this.checkPing();
            if (this.config.restartOnDisconnect && !this.redirectRunning) {
                this.log.info('Restart adapter by disconnect');
                // simulate scheduled restart
                this.timeouts.terminate = setTimeout(() => {
                    this.timeouts.terminate = null;
                    this.terminate ? this.terminate(-100) : process.exit(-100);
                }, 10000);
            }
            else {
                this.redirectRunning = false;
                this.startConnect();
            }
        }
    };
    onConnect = () => {
        if (!this.cloudConnected) {
            this.log.info('Connection changed: connect');
            this.cloudConnected = true;
            void this.setState('info.connection', this.cloudConnected, true);
            this.checkPing();
        }
        else {
            this.log.debug('Connection not changed: was cloudConnected');
        }
        if (this.connectTimer) {
            clearInterval(this.connectTimer);
            this.connectTimer = null;
        }
    };
    onCloudConnect = (clientId) => {
        this.log.info(`User accessed from cloud: ${clientId || ''}`);
        void this.setState('info.userOnCloud', true, true);
    };
    onCloudDisconnect = (clientId, name) => {
        this.log.info(`User disconnected from cloud: ${clientId || ''} ${name || ''}`);
        void this.setState('info.userOnCloud', false, true);
    };
    onCloudWait = (seconds) => {
        this.waiting = true;
        this.log.info(`Server asked to wait for ${seconds || 60} seconds`);
        if (this.socket) {
            this.socket.disconnect();
            // @ts-expect-error It is allowed to call without any arguments. Types are wrong
            this.socket.off();
            this.socket = null;
        }
        if (this.connectTimer) {
            clearInterval(this.connectTimer);
            this.connectTimer = null;
        }
        this.timeouts.onCloudWait = setTimeout(() => {
            this.timeouts.onCloudWait = null;
            this.waiting = false;
            this.startConnect(true);
        }, (seconds || 60) * 1000);
    };
    onCloudRedirect = async (data) => {
        if (!data) {
            this.log.info('Received invalid redirect command from server');
            return;
        }
        if (!data.url) {
            this.log.error('Received redirect, but no URL.');
        }
        else if (data.notSave) {
            this.redirectRunning = true;
            this.log.info(`Adapter redirected temporally to "${data.url}" ${this.config.cloudUrl.includes('https://iobroker.pro:') ? 'in 30 seconds' : 'in one minute'}. Reason: ${data && data.reason ? data.reason : 'command from server'}`);
            this.config.cloudUrl = data.url;
            if (this.socket) {
                this.socket.disconnect();
                // @ts-expect-error It is allowed to call without any arguments. Types are wrong
                this.socket.off();
            }
            this.startConnect();
        }
        else {
            this.log.info(`Adapter redirected continuously to "${data.url}". Reason: ${data?.reason ? data.reason : 'command from server'}`);
            try {
                const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                if (obj) {
                    obj.native.cloudUrl = data.url;
                    this.timeouts.redirect = setTimeout(() => {
                        this.timeouts.redirect = null;
                        this.setForeignObject(obj._id, obj, err => {
                            if (err) {
                                this.log.error(`redirectAdapter [setForeignObject]: ${err}`);
                            }
                            this.config.cloudUrl = data.url;
                            if (this.socket) {
                                this.socket.disconnect();
                                // @ts-expect-error It is allowed to call without any arguments. Types are wrong
                                this.socket.off();
                            }
                            this.startConnect();
                        });
                    }, 3000);
                }
            }
            catch (e) {
                this.log.error(`redirectAdapter [getForeignObject]: ${e}`);
            }
        }
    };
    onCloudError = (error) => {
        this.log.error(`Cloud says: ${error}`);
    };
    onCloudStop = () => {
        void this.getForeignObject(`system.adapter.${this.namespace}`, (err, obj) => {
            if (err) {
                this.log.error(`[onCloudStop]: ${err}`);
            }
            if (obj) {
                obj.common.enabled = false;
                this.timeouts.onCloudStop = setTimeout(() => {
                    this.timeouts.onCloudStop = null;
                    this.setForeignObject(obj._id, obj, err => {
                        if (err) {
                            this.log.error(`[setForeignObject]: ${err}`);
                        }
                        this.terminate ? this.terminate() : process.exit();
                    });
                }, 5000);
            }
            else {
                this.terminate ? this.terminate() : process.exit();
            }
        });
    };
    // this is a bug of socket.io
    // sometimes auto-reconnect does not work.
    startConnect(immediately) {
        if (this.waiting) {
            return;
        }
        if (this.connectTimer) {
            clearInterval(this.connectTimer);
            this.connectTimer = null;
        }
        this.connectTimer = setInterval(() => this.connect(), this.config.cloudUrl.includes('https://iobroker.pro:') ? 30000 : 60000); // on pro there are not so many users as on net.
        if (immediately) {
            void this.connect();
        }
    }
    initConnect() {
        this.ioSocket = new socketCloud_1.default(this.socket, {
            apikey: this.apikey,
            uuid: this.uuid,
            version: this.version,
        }, this, this.lovelaceServer);
        this.ioSocket.on('connect', this.onConnect);
        this.ioSocket.on('disconnect', this.onDisconnect);
        this.ioSocket.on('cloudError', this.onCloudError);
        this.ioSocket.on('cloudConnect', this.onCloudConnect);
        this.ioSocket.on('cloudDisconnect', this.onCloudDisconnect);
        this.ioSocket.on('connectWait', this.onCloudWait);
        this.ioSocket.on('cloudRedirect', this.onCloudRedirect);
        this.ioSocket.on('cloudStop', this.onCloudStop);
    }
    answerWithReason(instance, name, cb) {
        if (!instance) {
            this.log.error(`${name} instance not defined. Please specify the lovelace instance in settings`);
        }
        else {
            void this.getForeignObjectAsync(instance)
                .catch(() => null)
                .then(obj => {
                const conn = this.getConnectionString(obj, name);
                if (conn) {
                    if (!obj?.common.enabled) {
                        this.log.error(`${name} instance "${instance}" not activated.`);
                    }
                    else {
                        this.log.error(`${name} instance "${instance}" not available.`);
                    }
                }
            });
        }
        if (cb) {
            cb(`${name} is inactive`, 404, {}, `${name} is inactive`);
        }
    }
    async connect() {
        if (this.waiting) {
            return;
        }
        if (this.config.allowAdmin) {
            const obj = await this.getForeignObjectAsync(this.config.allowAdmin).catch(() => null);
            if (obj) {
                this.adminServer = this.getConnectionString(obj, 'admin');
            }
        }
        if (this.config.lovelace) {
            const obj = await this.getForeignObjectAsync(this.config.lovelace).catch(() => null);
            if (obj) {
                this.lovelaceServer = this.getConnectionString(obj, 'lovelace');
            }
        }
        if (this.config.instance) {
            const obj = await this.getForeignObjectAsync(this.config.instance).catch(() => null);
            if (obj) {
                this.webSupportsConfig = obj.common.version.split('.')[0] >= '7';
                this.server = this.getConnectionString(obj, 'web');
            }
        }
        this.log.debug(`Connection attempt to ${this.config.cloudUrl} ...`);
        if (this.socket) {
            this.socket.disconnect();
            // @ts-expect-error It is allowed to call without any arguments. Types are wrong
            this.socket.off();
        }
        this.socket = (0, socket_io_client_1.default)(this.config.cloudUrl, {
            transports: ['websocket'],
            autoConnect: true,
            reconnection: !this.config.restartOnDisconnect,
            rejectUnauthorized: !this.config.allowSelfSignedCertificate,
            randomizationFactor: 0.9,
            reconnectionDelay: 60000,
            timeout: parseInt(this.config.connectionTimeout, 10) || 10000,
            reconnectionDelayMax: 120000,
        });
        if (this.server || this.lovelaceServer || this.adminServer) {
            this.initConnect();
        }
        this.socket.on('connect_error', (error) => this.log.error(`Error while connecting to cloud: ${error}`));
        // cannot use "pong" because reserved by socket.io
        this.socket.on('pongg', ( /*error*/) => {
            if (this.timeouts.detectDisconnect) {
                clearTimeout(this.timeouts.detectDisconnect);
                this.timeouts.detectDisconnect = null;
            }
        });
        this.socket.on('method', (url, options, cb) => {
            if (url.startsWith('/lovelace/')) {
                url = url.replace(/^\/lovelace\//, '/');
                if (!this.lovelaceServer) {
                    this.answerWithReason(this.config.lovelace, 'lovelace', cb);
                }
                else {
                    (0, axios_1.default)({
                        url: this.lovelaceServer + url,
                        method: options.method,
                        data: options.body,
                        // responseType: 'arraybuffer',
                        validateStatus: status => status < 400,
                    })
                        .then(response => cb(null, response.status, response.headers, JSON.stringify(response.data)))
                        .catch(error => {
                        if (error.response) {
                            this.log.error(`Cannot request lovelace pages "${url}": ${error.response.data || error.response.status}`);
                            cb(error.response.data || error.response.status, error.response.status || 501, error.response.headers, JSON.stringify(error.response.data));
                        }
                        else {
                            this.log.error(`Cannot request lovelace pages "${url}": ${error.code}`);
                            cb(error.code, 501, {}, JSON.stringify({ error: 'unexpected error' }));
                        }
                    });
                }
            }
            else {
                this.log.error(`Unexpected request: ${url}`);
                if (!this.server) {
                    this.answerWithReason(this.config.instance, 'web', cb);
                }
                else {
                    (0, axios_1.default)({
                        url: this.server + url,
                        method: options.method,
                        data: options.body,
                        // responseType: 'arraybuffer',
                        validateStatus: status => status < 400,
                    })
                        .then(response => cb(null, response.status, response.headers, JSON.stringify(response.data)))
                        .catch(error => {
                        if (error.response) {
                            this.log.error(`Cannot request web pages "${this.server}${url}": ${error.response.data || error.response.status}`);
                            cb(error.response.data || error.response.status, error.response.status || 501, error.response.headers, JSON.stringify(error.response.data));
                        }
                        else {
                            this.log.error(`Cannot request web pages "${this.server}${url}": ${error.code}`);
                            cb(error.code, 501, {}, JSON.stringify({ error: 'unexpected error' }));
                        }
                    });
                }
            }
        });
        this.socket.on('html', (url, cb) => {
            try {
                if (url.match(/^\/admin\//)) {
                    if (this.adminServer && this.config.allowAdmin) {
                        url = url.substring(6);
                        if (url.includes('loginBackgroundImage')) {
                            console.log('AAA');
                        }
                        if (url === '/@@loginBackgroundImage@@') {
                            url = '/files/admin.0/login-bg.png';
                        }
                        axios_1.default
                            .get(this.adminServer + url, {
                            responseType: 'arraybuffer',
                            validateStatus: status => status < 400,
                        })
                            .then(response => cb(null, response.status, response.headers, response.data))
                            .catch(error => {
                            if (error.response) {
                                this.log.error(`Cannot request admin pages: ${error.response.data || error.response.status}`);
                                cb(error.code, error.response.status || 501, error.response.headers, error.response.data);
                            }
                            else {
                                this.log.error('Cannot request admin pages: no response');
                                cb('no response', 501, {}, 'no response from admin');
                            }
                        });
                    }
                    else {
                        this.answerWithReason(this.config.allowAdmin, 'admin');
                        cb('Enable admin in cloud settings. And only pro.', 404, {}, 'Enable admin in cloud settings. And only pro.');
                    }
                }
                else if (url.startsWith('/adapter/') ||
                    url.startsWith('/lib/js/ace-') ||
                    url.startsWith('/lib/js/cron') ||
                    url.startsWith('/lib/js/jqGrid')) {
                    // if admin
                    if (this.adminServer && this.config.allowAdmin) {
                        axios_1.default
                            .get(this.adminServer + url, {
                            responseType: 'arraybuffer',
                            validateStatus: status => status < 400,
                        })
                            .then(response => cb(null, response.status, response.headers, response.data))
                            .catch(error => {
                            if (error.response) {
                                this.log.error(`Cannot request admin pages: ${error.response.data || error.response.status}`);
                                cb(error.code, error.response.status || 501, error.response.headers, error.response.data);
                            }
                            else {
                                this.log.error('Cannot request admin pages: no response');
                                cb('no response', 501, {}, 'no response from admin');
                            }
                        });
                    }
                    else {
                        this.answerWithReason(this.config.allowAdmin, 'admin');
                        cb('Enable admin in cloud settings. And only pro.', 404, {}, 'Enable admin in cloud settings. And only pro.');
                    }
                }
                else if (url.startsWith('/lovelace/')) {
                    // if lovelace
                    if (this.lovelaceServer && this.config.lovelace) {
                        url = url.replace(/^\/lovelace\//, '/');
                        axios_1.default
                            .get(this.lovelaceServer + url, {
                            responseType: 'arraybuffer',
                            validateStatus: status => status < 400,
                        })
                            .then(response => cb(null, response.status, response.headers, response.data))
                            .catch(error => {
                            if (error.response) {
                                this.log.error(`Cannot request lovelace pages "${this.lovelaceServer + url}": ${error.response.data || error.response.status}`);
                                cb(error.code, error.response.status || 501, error.response.headers, error.response.data);
                            }
                            else {
                                this.log.error(`Cannot request lovelace pages "${this.lovelaceServer + url}": no response`);
                                cb('no response', 501, {}, 'no response from lovelace');
                            }
                        });
                    }
                    else {
                        this.answerWithReason(this.config.lovelace, 'lovelace', cb);
                    }
                }
                else if (this.server) {
                    // cloud wants to know the list of possible instances
                    /* Remove comments after the new cloud is online
                    if (url === '/' && this.webSupportsConfig) {
                        // this is possible only with a new Cloud. Activate it later
                        axios
                            .get(`${this.server}/config.json`, {
                                responseType: 'arraybuffer',
                                validateStatus: status => status < 400,
                            })
                            .then(response =>
                                cb(
                                    null,
                                    response.status,
                                    response.headers as Record<string, string>,
                                    response.data,
                                ),
                            )
                            .catch(error => {
                                if (error.response) {
                                    this.log.error(
                                        `Cannot request web pages "${this.server + url}": ${error.response.data || error.response.status}`,
                                    );
                                    cb(
                                        error.code,
                                        error.response.status || 501,
                                        error.response.headers,
                                        error.response.data,
                                    );
                                } else {
                                    this.log.error(`Cannot request web pages"${this.server + url}": no response`);
                                    cb('no response', 501, {}, 'no response from web');
                                }
                            });
                        return;
                    }
                    */
                    // web
                    axios_1.default
                        .get(this.server + url, {
                        responseType: 'arraybuffer',
                        validateStatus: status => status < 400,
                    })
                        .then(response => cb(null, response.status, response.headers, response.data))
                        .catch(error => {
                        if (error.response) {
                            this.log.error(`Cannot request web pages "${this.server + url}": ${error.response.data || error.response.status}`);
                            cb(error.code, error.response.status || 501, error.response.headers, error.response.data);
                        }
                        else {
                            this.log.error(`Cannot request web pages"${this.server + url}": no response`);
                            cb('no response', 501, {}, 'no response from web');
                        }
                    });
                }
                else {
                    // analyse answer
                    this.answerWithReason(this.config.instance, 'web', cb);
                }
            }
            catch (e) {
                this.log.error(`Cannot request: ${e}`);
                cb('Admin or Web are inactive.', 404, {}, 'Admin or Web are inactive.');
            }
        });
        this.socket.on('ifttt', this.processIfttt);
        this.socket.on('iftttError', (error) => this.log.error(`Error from IFTTT: ${JSON.stringify(error)}`));
        this.socket.on('cloudError', (error) => this.log.error(`Cloud says: ${error}`));
        this.socket.on('service', async (data, callback) => {
            this.log.debug(`service: ${JSON.stringify(data)}`);
            // supported services:
            // - text2command
            // - simpleApi
            // - custom, e.g. torque
            if (!data?.name) {
                if (callback) {
                    callback({ error: 'no name' });
                }
            }
            else if (data.name === 'ifttt' && this.config.iftttKey) {
                await this.processIfttt(data.data);
                callback?.();
            }
            else {
                let isCustom = false;
                if (data.name.match(/^custom_/)) {
                    data.name = data.name.substring(7);
                    isCustom = true;
                }
                if (this.config.allowedServices[0] === '*' || this.config.allowedServices.includes(data.name)) {
                    if (!isCustom && data.name === 'text2command') {
                        if (this.config.text2command !== undefined && this.config.text2command !== '') {
                            this.setForeignState(`text2command.${this.config.text2command}.text`, decodeURIComponent(data.data), err => {
                                callback?.({ result: err?.toString() || 'Ok' });
                            });
                        }
                        else {
                            this.log.warn('Received service text2command, but instance is not defined');
                            callback?.({ error: 'instance is not defined' });
                        }
                    }
                    else if (!isCustom && (data.name === 'simpleApi' || data.name === 'simpleapi')) {
                        // GET https://iobroker.net/service/simpleApi/<user-app-key>/get/system.this.admin.0.cputime
                        const parts = (data.data || '').split('/');
                        if (parts[0] === 'get') {
                            if (callback) {
                                try {
                                    const state = await this.getForeignStateAsync(parts[1]);
                                    if (state) {
                                        state.result = 'Ok';
                                        callback(state);
                                    }
                                    else {
                                        callback({ result: 'Not found' });
                                    }
                                }
                                catch (error) {
                                    callback({ error: error.toString() });
                                }
                            }
                        }
                        else if (parts[0] === 'getPlainValue') {
                            if (callback) {
                                try {
                                    const state = await this.getForeignStateAsync(parts[1]);
                                    if (state) {
                                        callback({ result: 'Ok', val: state.val, plain: true });
                                    }
                                    else {
                                        callback({ result: 'Not found', val: null, plain: true });
                                    }
                                }
                                catch (error) {
                                    callback({ error: error.toString() });
                                }
                            }
                        }
                        else if (parts[0] === 'set') {
                            // https://iobroker.pro/service/simpleapi/<user-app-key>/set/stateID?value=1
                            if (callback) {
                                const result = parts[1].split('?');
                                const id = result[0];
                                let val = result[1];
                                if (id === undefined || val === undefined) {
                                    callback({ error: 'invalid call' });
                                    return;
                                }
                                val = val.replace(/^value=/, '');
                                try {
                                    const obj = await this.getForeignObjectAsync(id);
                                    if (obj?.type !== 'state') {
                                        callback({ error: 'only states can be controlled' });
                                    }
                                    else {
                                        if (obj.common?.type === 'boolean') {
                                            await this.setForeignStateAsync(id, val === 'true' || val === '1' || val === 'ON' || val === 'on');
                                        }
                                        else if (obj.common?.type === 'number') {
                                            await this.setForeignStateAsync(id, parseFloat(val));
                                        }
                                        else {
                                            await this.setForeignStateAsync(id, val);
                                        }
                                        callback({ result: 'Ok' });
                                    }
                                }
                                catch (e) {
                                    callback({ error: e.toString() });
                                }
                            }
                        }
                        else {
                            callback?.({ error: 'not implemented' });
                        }
                    }
                    else if (isCustom) {
                        const obj = await this.getObjectAsync(`services.custom_${data.name}`);
                        if (!obj) {
                            try {
                                await this.setObjectAsync(`services.custom_${data.name}`, {
                                    _id: `${this.namespace}.services.custom_${data.name}`,
                                    type: 'state',
                                    common: {
                                        name: `Service for ${data.name}`,
                                        write: false,
                                        read: true,
                                        type: 'mixed',
                                        role: 'value',
                                    },
                                    native: {},
                                });
                            }
                            catch (e) {
                                callback?.({ result: e.toString() });
                                return;
                            }
                        }
                        try {
                            await this.setStateAsync(`services.custom_${data.name}`, data.data, false);
                            callback?.({ result: 'Ok' });
                        }
                        catch (e) {
                            callback?.({ result: e.toString() });
                        }
                    }
                    else {
                        callback?.({ error: 'not allowed' });
                    }
                }
                else {
                    this.log.warn(`Received service "${data.name}", but it is not found in whitelist`);
                    callback?.({ error: 'blocked' });
                }
            }
        });
        this.socket.on('error', (error) => {
            console.error(`Some error: ${error}`);
            this.startConnect();
        });
    }
    _createAppKey(cb) {
        this.log.info('Create new APP-KEY...');
        const url = `https://${this.config.server}:3001/api/v1/appkeys`;
        axios_1.default
            .post(url, null, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${this.config.login}:${this.config.pass}`).toString('base64')}`,
            },
            validateStatus: (status) => status < 400,
        })
            .then(response => {
            const body = response.data;
            if (body?.key?.[0]) {
                this.log.info(`New APP-KEY is ${body.key[0]}`);
                cb(null, body.key[0]);
            }
            else {
                cb(`Cannot create app-key on server "${url}": ${JSON.stringify(body)}`);
            }
        })
            .catch(error => {
            if (error.code === 'ECONNREFUSED') {
                this.log.warn('Server is offline or no connection. Retry in 10 seconds');
                this.timeouts.createAppKey = setTimeout(() => {
                    this.timeouts.createAppKey = null;
                    this._createAppKey(cb);
                }, 10000);
            }
            else if (error.response?.status === 401) {
                return cb(`Invalid user name or password or server (may be it is ${this.config.server === 'iobroker.pro' ? 'iobroker.net' : 'iobroker.pro'})`);
            }
            else if (error.response?.data) {
                const body = error.response.data;
                if (body?.key?.[0]) {
                    this.log.info(`New APP-KEY is ${body.key[0]}`);
                    cb(null, body.key[0]);
                }
                else {
                    cb(`Cannot create app-key on server "${url}": ${error.response?.status ||
                        (error.response?.data && JSON.stringify(error.response.data)) ||
                        'unknown error'}`);
                }
            }
            else {
                cb(`Cannot create app-key on server "${url}": ${error.code || 'unknown error'}`);
            }
        });
    }
    _readAppKeyFromCloud(server, login, password, cb) {
        server ||= this.config.server;
        login ||= this.config.login;
        password ||= this.config.pass;
        if (!server.length) {
            cb('Servername not provided. Please check your configuration!');
            return;
        }
        if (!login.length) {
            cb('Login not provided. Please check your configuration!');
            return;
        }
        if (!password.length) {
            cb('Password not provided. Please check your configuration!');
            return;
        }
        const url = `https://${server}:3001/api/v1/appkeys`;
        axios_1.default
            .get(url, {
            headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}` },
            validateStatus: status => status < 400,
        })
            .then(response => {
            const body = response.data;
            if (body?.[0]?.key) {
                cb(null, body[0].key);
            }
            else if (body) {
                this._createAppKey(cb);
            }
            else {
                // todo: create key
                cb(`Cannot create app-key on server "${url}": ${body ? JSON.stringify(body) : 'key does not exist'}`);
            }
        })
            .catch(error => {
            if (error.code === 'ECONNREFUSED') {
                this.log.warn('Server is offline or no connection. Retry in 10 seconds');
                this.timeouts.readAppKey = setTimeout(() => {
                    this.timeouts.readAppKey = null;
                    this._readAppKeyFromCloud(server, login, password, cb);
                }, 10000);
            }
            else if (error.response && error.response.status === 401) {
                return cb(`Invalid user name or password or server (may be it is ${this.config.server === 'iobroker.pro' ? 'iobroker.net' : 'iobroker.pro'})`);
            }
            else if (error.response && error.response.data) {
                const body = error.response.data;
                if (body?.[0]?.key) {
                    this.log.info(`New APP-KEY is ${body[0].key}`);
                    cb(null, body[0].key);
                }
                else {
                    cb(`Cannot create app-key on server "${url}": ${(error.response && error.response.status) ||
                        (error.response && error.response.data && JSON.stringify(error.response.data)) ||
                        'unknown error'}`);
                }
            }
            else {
                cb(`Cannot create app-key on server "${url}": ${error.code || 'unknown error'}`);
            }
        });
    }
    readAppKeyFromCloud() {
        return new Promise((resolve, reject) => this._readAppKeyFromCloud(undefined, undefined, undefined, (err, key) => err ? reject(new Error(err)) : resolve(key)));
    }
    async main() {
        this.config.pingTimeout = parseInt(this.config.pingTimeout, 10) || 5000;
        if (this.config.pingTimeout < 3000) {
            this.config.pingTimeout = 3000;
        }
        if (this.config.deviceOffLevel === undefined) {
            this.config.deviceOffLevel = 30;
        }
        this.config.deviceOffLevel = parseFloat(this.config.deviceOffLevel) || 0;
        this.config.concatWord = (this.config.concatWord || '').toString().trim();
        this.config.apikey = (this.config.apikey || '').trim();
        this.config.replaces = Array.isArray(this.config.replaces)
            ? this.config.replaces
            : this.config.replaces?.split(',') || null;
        this.config.cloudUrl = (this.config.cloudUrl || '').toString();
        this.config.pass = this.config.pass || '';
        this.config.login = this.config.login || '';
        this.config.server = this.config.server || 'iobroker.pro';
        if (this.config.login !== (this.config.login || '').trim().toLowerCase()) {
            this.log.error('Please write your login only in lowercase!');
        }
        if (this.config.login && this.config.pass && this.config.useCredentials) {
            if (this.config.server === 'iobroker.pro') {
                this.config.cloudUrl = this.config.cloudUrl.replace('iobroker.net', 'iobroker.pro');
            }
            else if (this.config.server === 'iobroker.net') {
                this.config.cloudUrl = this.config.cloudUrl.replace('iobroker.pro', 'iobroker.net');
            }
            this.apikey = await this.readAppKeyFromCloud();
        }
        else {
            this.apikey = this.config.apikey;
        }
        if (this.apikey?.startsWith('@pro_')) {
            if (!this.config.cloudUrl.startsWith('https://iobroker.pro:')) {
                this.config.cloudUrl = 'https://iobroker.pro:10555';
            }
        }
        else {
            this.config.allowAdmin = false;
            this.config.lovelace = false;
        }
        if (this.config.replaces) {
            const text = [];
            for (let r = 0; r < this.config.replaces.length; r++) {
                text.push(`"${this.config.replaces.join(', ')}"`);
            }
            this.log.debug(`Following strings will be replaced in names: ${text.join(', ')}`);
        }
        // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        if (typeof this.config.allowedServices === 'string') {
            this.config.allowedServices = (this.config.allowedServices || '').split(/[,\s]+/);
        }
        else if (!Array.isArray(this.config.allowedServices)) {
            this.config.allowedServices = [];
        }
        this.config.allowedServices = this.config.allowedServices.map(s => s.trim());
        await this.setStateAsync('info.connection', false, true);
        this.config.cloudUrl = this.config.cloudUrl || 'https://iobroker.net:10555';
        if (!this.apikey) {
            return this.log.error('No api-key found. Please get one on https://iobroker.net');
        }
        if (this.config.iftttKey) {
            await this.subscribeStatesAsync('services.ifttt');
            // create ifttt object
            try {
                const obj = await this.getObjectAsync('services.ifttt');
                if (!obj) {
                    await this.setObjectAsync('services.ifttt', {
                        _id: `${this.namespace}.services.ifttt`,
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
            }
            catch (e) {
                this.log.error(e);
            }
        }
        if (this.config.instance && !this.config.instance.startsWith('system.adapter.')) {
            this.config.instance = `system.adapter.${this.config.instance}`;
        }
        if (this.config.allowAdmin && !this.config.allowAdmin.startsWith('system.adapter.')) {
            this.config.allowAdmin = `system.adapter.${this.config.allowAdmin}`;
        }
        if (this.config.lovelace && !this.config.lovelace.startsWith('system.adapter.')) {
            this.config.lovelace = `system.adapter.${this.config.lovelace}`;
        }
        this.subscribeStates('smart.*');
        if (this.config.instance) {
            try {
                await this.subscribeForeignObjectsAsync(this.config.instance);
            }
            catch (err) {
                this.log.error(`Cannot subscribe: ${err}`);
            }
        }
        if (this.config.allowAdmin) {
            try {
                await this.subscribeForeignObjectsAsync(this.config.allowAdmin);
            }
            catch (err) {
                this.log.error(`Cannot subscribe: ${err}`);
            }
        }
        if (this.config.lovelace) {
            try {
                await this.subscribeForeignObjectsAsync(this.config.lovelace);
            }
            catch (err) {
                this.log.error(`Cannot subscribe: ${err}`);
            }
        }
        this.log.info(`Connecting with ${this.config.cloudUrl} with "${this.apikey}"`);
        const uuidObj = await this.getForeignObjectAsync('system.meta.uuid');
        if (uuidObj?.native) {
            this.uuid = uuidObj.native.uuid;
        }
        if (!this.uuid) {
            throw new Error('No UUID found');
        }
        this.startConnect(true);
    }
}
exports.CloudAdapter = CloudAdapter;
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new CloudAdapter(options);
}
else {
    // otherwise start the instance directly
    (() => new CloudAdapter())();
}
//# sourceMappingURL=main.js.map