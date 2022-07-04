let axios = null;
let zipFiles;

// taken from here: https://github.com/ioBroker/ioBroker.js-controller/blob/master/packages/common/src/lib/common/tools.ts#L2386
/**
 * Converts ioB pattern into regex.
 * @param pattern - Regex string to use it in new RegExp(pattern)
 */
function pattern2RegEx(pattern) {
    pattern = (pattern || '').toString();

    const startsWithWildcard = pattern[0] === '*';
    const endsWithWildcard = pattern[pattern.length - 1] === '*';

    pattern = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');

    return (startsWithWildcard ? '' : '^') + pattern + (endsWithWildcard ? '' : '$');
}

class SocketCommands {
    static ERROR_PERMISSION = 'permissionError';
    static COMMANDS_PERMISSIONS = {
        getObject:          {type: 'object',    operation: 'read'},
        getObjects:         {type: 'object',    operation: 'list'},
        getObjectView:      {type: 'object',    operation: 'list'},
        setObject:          {type: 'object',    operation: 'write'},
        requireLog:         {type: 'object',    operation: 'write'}, // just mapping to some command
        delObject:          {type: 'object',    operation: 'delete'},
        extendObject:       {type: 'object',    operation: 'write'},
        getHostByIp:        {type: 'object',    operation: 'list'},
        subscribeObjects:   {type: 'object',    operation: 'read'},
        unsubscribeObjects: {type: 'object',    operation: 'read'},

        getStates:          {type: 'state',     operation: 'list'},
        getState:           {type: 'state',     operation: 'read'},
        setState:           {type: 'state',     operation: 'write'},
        delState:           {type: 'state',     operation: 'delete'},
        createState:        {type: 'state',     operation: 'create'},
        subscribe:          {type: 'state',     operation: 'read'},
        unsubscribe:        {type: 'state',     operation: 'read'},
        getStateHistory:    {type: 'state',     operation: 'read'},
        getVersion:         {type: '',          operation: ''},
        getAdapterName:     {type: '',          operation: ''},

        addUser:            {type: 'users',     operation: 'create'},
        delUser:            {type: 'users',     operation: 'delete'},
        addGroup:           {type: 'users',     operation: 'create'},
        delGroup:           {type: 'users',     operation: 'delete'},
        changePassword:     {type: 'users',     operation: 'write'},

        httpGet:            {type: 'other',     operation: 'http'},
        cmdExec:            {type: 'other',     operation: 'execute'},
        sendTo:             {type: 'other',     operation: 'sendto'},
        sendToHost:         {type: 'other',     operation: 'sendto'},
        readLogs:           {type: 'other',     operation: 'execute'},

        readDir:            {type: 'file',      operation: 'list'},
        createFile:         {type: 'file',      operation: 'create'},
        writeFile:          {type: 'file',      operation: 'write'},
        readFile:           {type: 'file',      operation: 'read'},
        fileExists:         {type: 'file',      operation: 'read'},
        deleteFile:         {type: 'file',      operation: 'delete'},
        readFile64:         {type: 'file',      operation: 'read'},
        writeFile64:        {type: 'file',      operation: 'write'},
        unlink:             {type: 'file',      operation: 'delete'},
        rename:             {type: 'file',      operation: 'write'},
        mkdir:              {type: 'file',      operation: 'write'},
        chmodFile:          {type: 'file',      operation: 'write'},
        chownFile:          {type: 'file',      operation: 'write'},
        subscribeFiles:     {type: 'file',      operation: 'read'},
        unsubscribeFiles:   {type: 'file',      operation: 'read'},

        authEnabled:        {type: '',          operation: ''},
        disconnect:         {type: '',          operation: ''},
        listPermissions:    {type: '',          operation: ''},
        getUserPermissions: {type: 'object',    operation: 'read'}
    };

    constructor(adapter, updateSession) {
        this.adapter    = adapter;
        this.commands   = {};
        this.subscribes = {};
        this.logEnabled = false;

        this._updateSession = updateSession;

        if (!this._updateSession) {
            this._updateSession = () => true;
        }

        this._initCommands();
    }

    async _rename(_adapter, oldName, newName, options) {
        // read if it is a file or folder
        try {
            if (oldName.endsWith('/')) {
                oldName = oldName.substring(0, oldName.length - 1);
            }

            if (newName.endsWith('/')) {
                newName = newName.substring(0, newName.length - 1);
            }

            const files = await this.adapter.readDirAsync(_adapter, oldName, options);
            if (files && files.length) {
                for (let f = 0; f < files.length; f++) {
                    await this._rename(_adapter, `${oldName}/${files[f].file}`, `${newName}/${files[f].file}`);
                }
            }
        } catch (error) {
            if (error.message !== 'Not exists') {
                throw error;
            }
            // else ignore, because it is a file and not a folder
        }

        try {
            await this.adapter.renameAsync(_adapter, oldName, newName, options);
        } catch (error) {
            if (error.message !== 'Not exists') {
                throw error;
            }
            // else ignore, because folder cannot be deleted
        }
    }

    async _unlink(_adapter, name, options) {
        // read if it is a file or folder
        try {
            // remove trailing '/'
            if (name.endsWith('/')) {
                name = name.substring(0, name.length - 1);
            }
            const files = await this.adapter.readDirAsync(_adapter, name, options);
            if (files && files.length) {
                for (let f = 0; f < files.length; f++) {
                    await this._unlink(_adapter, name + '/' + files[f].file);
                }
            }
        } catch (error) {
            // ignore, because it is a file and not a folder
            if (error.message !== 'Not exists') {
                throw error;
            }
        }

        try {
            await this.adapter.unlinkAsync(_adapter, name, options);
        } catch (error) {
            if (error.message !== 'Not exists') {
                throw error;
            }
            // else ignore, because folder cannot be deleted
        }
    }

    /**
     * Convert errors into strings and then call cb
     * @param {function} cb - callback
     * @param {string|Error|null} err - error argument
     * @param {any[]} args - args passed to cb
     */
    static _fixCallback(cb, err, ...args) {
        if (typeof cb !== 'function') {
            return;
        }

        if (err instanceof Error) {
            err = err.message;
        }

        cb(err, ...args);
    }

    _checkPermissions(socket, command, callback, arg) {
        if (socket._acl.user !== 'system.user.admin') {
            // type: file, object, state, other
            // operation: create, read, write, list, delete, sendto, execute, sendToHost, readLogs
            if (SocketCommands.COMMANDS_PERMISSIONS[command]) {
                // If permission required
                if (SocketCommands.COMMANDS_PERMISSIONS[command].type) {
                    if (socket._acl[SocketCommands.COMMANDS_PERMISSIONS[command].type] &&
                        socket._acl[SocketCommands.COMMANDS_PERMISSIONS[command].type][SocketCommands.COMMANDS_PERMISSIONS[command].operation]) {
                        return true;
                    } else {
                        this.adapter.log.warn(`No permission for "${socket._acl.user}" to call ${command}. Need "${SocketCommands.COMMANDS_PERMISSIONS[command].type}"."${SocketCommands.COMMANDS_PERMISSIONS[command].operation}"`);
                    }
                } else {
                    return true;
                }
            } else {
                this.adapter.log.warn('No rule for command: ' + command);
            }

            if (typeof callback === 'function') {
                callback(SocketCommands.ERROR_PERMISSION);
            } else {
                if (SocketCommands.COMMANDS_PERMISSIONS[command]) {
                    socket.emit(SocketCommands.ERROR_PERMISSION, {
                        command,
                        type: SocketCommands.COMMANDS_PERMISSIONS[command].type,
                        operation: SocketCommands.COMMANDS_PERMISSIONS[command].operation,
                        arg
                    });
                } else {
                    socket.emit(SocketCommands.ERROR_PERMISSION, {command, arg});
                }
            }
            return false;
        } else {
            return true;
        }
    }

    publish(socket, type, id, obj) {
        if (socket && socket.subscribe && socket.subscribe[type] && this._updateSession(socket)) {
            return !!socket.subscribe[type].find(sub => {
                if (sub.regex.test(id)) {
                    // replace language
                    if (this.adapter._language && id === 'system.config' && obj.common) {
                        obj.common.language = this.adapter._language;
                    }
                    socket.emit(type, id, obj);
                    return true;
                }
            });
        }

        return false;
    }

    publishFile(socket, id, fileName, size) {
        if (socket && socket.subscribe && socket.subscribe.fileChange && this._updateSession(socket)) {
            const key = id + '####' + fileName;
            return !!socket.subscribe.fileChange.find(sub => {
                if (sub.regex.test(key)) {
                    socket.emit('fileChange', id, fileName, size);
                    return true;
                }
            });
        }

        return false;
    }

    _showSubscribes(socket, type) {
        if (socket && socket.subscribe) {
            const s = socket.subscribe[type] || [];
            const ids = [];
            for (let i = 0; i < s.length; i++) {
                ids.push(s[i].pattern);
            }
            this.adapter.log.debug('Subscribes: ' + ids.join(', '));
        } else {
            this.adapter.log.debug('Subscribes: no subscribes');
        }
    }

    isLogEnabled() {
        return this.logEnabled;
    }

    subscribe(socket, type, pattern, patternFile) {
        this.subscribes[type] = this.subscribes[type] || {};

        let p;
        let key;
        pattern = pattern.toString();
        if (patternFile && type === 'fileChange') {
            patternFile = patternFile.toString();
            key = pattern + '####' + patternFile;
        } else {
            key = pattern;
        }

        p = pattern2RegEx(key);
        if (p === null) {
            return this.adapter.log.warn('Empty pattern on subscribe!');
        }

        let s;
        if (socket) {
            socket.subscribe = socket.subscribe || {};
            s = socket.subscribe[type] = socket.subscribe[type] || [];

            if (s.find(item => item.pattern === key)) {
                return;
            }
            s.push({pattern: key, regex: new RegExp(p)});
        }

        if (this.subscribes[type][key] === undefined) {
            this.subscribes[type][key] = 1;
            if (type === 'stateChange') {
                this.adapter.subscribeForeignStates(pattern);
            } else if (type === 'objectChange') {
                this.adapter.subscribeForeignObjects && this.adapter.subscribeForeignObjects(pattern);
            } else if (type === 'log') {
                if (!this.logEnabled && this.adapter.requireLog) {
                    this.logEnabled = true;
                    this.adapter.requireLog(true);
                }
            } else if (type === 'fileChange') {
                this.adapter.subscribeForeignFiles && this.adapter.subscribeForeignFiles(pattern, patternFile);
            }
        } else {
            this.subscribes[type][key]++;
        }
    };

    unsubscribe(socket, type, pattern, patternFile) {
        //console.log((socket._name || socket.id) + ' unsubscribe ' + pattern);
        if (!this.subscribes[type]) {
            return;
        }

        let key;
        pattern = pattern.toString();
        if (patternFile && type === 'fileChange') {
            patternFile = patternFile.toString();
            key = pattern + '####' + patternFile;
        } else {
            key = pattern;
        }

        if (socket && typeof socket === 'object') {
            if (!socket.subscribe || !socket.subscribe[type]) {
                return;
            }

            for (let i = socket.subscribe[type].length - 1; i >= 0; i--) {
                if (socket.subscribe[type][i].pattern === key) {

                    // Remove pattern from global list
                    if (this.subscribes[type][key] !== undefined) {
                        this.subscribes[type][key]--;
                        if (this.subscribes[type][key] <= 0) {
                            if (type === 'stateChange') {
                                //console.log((socket._name || socket.id) + ' unsubscribeForeignStates ' + pattern);
                                this.adapter.unsubscribeForeignStates(pattern);
                            } else if (type === 'objectChange') {
                                //console.log((socket._name || socket.id) + ' unsubscribeForeignObjects ' + pattern);
                                this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                            } else if (type === 'log') {
                                //console.log((socket._name || socket.id) + ' requireLog false');
                                if (this.logEnabled && this.adapter.requireLog) {
                                    this.logEnabled = false;
                                    this.adapter.requireLog(false);
                                }
                            } else if (type === 'fileChange') {
                                //console.log((socket._name || socket.id) + ' requireLog false');
                                this.adapter.unsubscribeForeignFiles && this.adapter.unsubscribeForeignFiles(pattern, patternFile);
                            }
                            delete this.subscribes[type][pattern];
                        }
                    }

                    delete socket.subscribe[type][i];
                    socket.subscribe[type].splice(i, 1);
                    return;
                }
            }
        } else if (key) {
            // Remove pattern from global list
            if (this.subscribes[type][key] !== undefined) {
                this.subscribes[type][key]--;
                if (this.subscribes[type][key] <= 0) {
                    if (type === 'stateChange') {
                        this.adapter.unsubscribeForeignStates(pattern);
                    } else if (type === 'objectChange') {
                        this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                    } else if (type === 'log') {
                        if (this.adapter.requireLog && this.logEnabled) {
                            this.logEnabled = false;
                            this.adapter.requireLog(false);
                        }
                    } else if (type === 'fileChange') {
                        this.adapter.unsubscribeForeignFiles && this.adapter.unsubscribeForeignFiles(pattern, patternFile);
                    }
                    delete this.subscribes[type][key];
                }
            }
        } else {
            Object.keys(this.subscribes[type]).forEach(pattern => {
                if (type === 'stateChange') {
                    //console.log((socket._name || socket.id) + ' unsubscribeForeignStates ' + pattern);
                    this.adapter.unsubscribeForeignStates(pattern);
                } else if (type === 'objectChange') {
                    //console.log((socket._name || socket.id) + ' unsubscribeForeignObjects ' + pattern);
                    this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                } else if (type === 'log') {
                    //console.log((socket._name || socket.id) + ' requireLog false');
                    if (this.adapter.requireLog && this.logEnabled) {
                        this.logEnabled = false;
                        this.adapter.requireLog(false);
                    }
                } else if (type === 'fileChange') {
                    const [id, fileName] = pattern.split('####');
                    this.adapter.unsubscribeForeignFiles && this.adapter.unsubscribeForeignFiles(id, fileName);
                }
            });

            this.subscribes[type] = {}
        }
    };

    subscribeSocket(socket, type) {
        if (!socket || !socket.subscribe) {
            return;
        }

        if (!type) {
            // all
            return Object.keys(socket.subscribe).forEach(type => this.subscribeSocket(socket, type));
        }

        if (!socket.subscribe[type]) {
            return;
        }

        for (let i = 0; i < socket.subscribe[type].length; i++) {
            const pattern = socket.subscribe[type][i].pattern;
            if (this.subscribes[type][pattern] === undefined) {
                this.subscribes[type][pattern] = 1;
                if (type === 'stateChange') {
                    this.adapter.subscribeForeignStates(pattern);
                } else if (type === 'objectChange') {
                    this.adapter.subscribeForeignObjects && this.adapter.subscribeForeignObjects(pattern);
                } else if (type === 'log') {
                    if (this.adapter.requireLog && !this.logEnabled) {
                        this.logEnabled = true;
                        this.adapter.requireLog(true);
                    }
                }
            } else {
                this.subscribes[type][pattern]++;
            }
        }
    }

    unsubscribeSocket(socket, type) {
        if (!socket || !socket.subscribe) {
            return;
        }

        if (!type) {
            // all
            return Object.keys(socket.subscribe).forEach(type => this.unsubscribeSocket(socket, type));
        }

        if (!socket.subscribe[type]) {
            return;
        }

        for (let i = 0; i < socket.subscribe[type].length; i++) {
            const pattern = socket.subscribe[type][i].pattern;
            if (this.subscribes[type][pattern] !== undefined) {
                this.subscribes[type][pattern]--;
                if (this.subscribes[type][pattern] <= 0) {
                    if (type === 'stateChange') {
                        this.adapter.unsubscribeForeignStates(pattern);
                    } else if (type === 'objectChange') {
                        this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                    } else if (type === 'log') {
                        if (this.adapter.requireLog && !this.logEnabled) {
                            this.logEnabled = true;
                            this.adapter.requireLog(true);
                        }
                    }
                    delete this.subscribes[type][pattern];
                }
            }
        }
    }

    _subscribeStates(socket, pattern, callback) {
        if (this._checkPermissions(socket, 'subscribe', callback, pattern)) {
            if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                for (let p = 0; p < pattern.length; p++) {
                    this.subscribe(socket, 'stateChange', pattern[p]);
                }
            } else {
                this.subscribe(socket, 'stateChange', pattern);
            }

            this.adapter.log.level === 'debug' && this._showSubscribes(socket, 'stateChange');

            typeof callback === 'function' && setImmediate(callback, null);
        }
    }

    _unsubscribeStates(socket, pattern, callback) {
        if (this._checkPermissions(socket, 'unsubscribe', callback, pattern)) {
            if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                for (let p = 0; p < pattern.length; p++) {
                    this.unsubscribe(socket, 'stateChange', pattern[p]);
                }
            } else {
                this.unsubscribe(socket, 'stateChange', pattern);
            }

            this.adapter.log.level === 'debug' && this._showSubscribes(socket, 'stateChange');

            typeof callback === 'function' && setImmediate(callback, null);
        }
    }

    _subscribeFiles(socket, id, pattern, callback) {
        if (this._checkPermissions(socket, 'subscribeFiles', callback, pattern)) {
            if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                for (let p = 0; p < pattern.length; p++) {
                    this.subscribe(socket, 'fileChange', id, pattern[p]);
                }
            } else {
                this.subscribe(socket, 'fileChange', id, pattern);
            }

            this.adapter.log.level === 'debug' && this._showSubscribes(socket, 'fileChange');

            typeof callback === 'function' && setImmediate(callback, null);
        }
    }

    _unsubscribeFiles(socket, id, pattern, callback) {
        if (this._checkPermissions(socket, 'unsubscribeFiles', callback, pattern)) {
            if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                for (let p = 0; p < pattern.length; p++) {
                    this.unsubscribe(socket, 'fileChange', id, pattern[p]);
                }
            } else {
                this.unsubscribe(socket, 'fileChange', pattern);
            }

            this.adapter.log.level === 'debug' && this._showSubscribes(socket, 'fileChange');

            typeof callback === 'function' && setImmediate(callback, null);
        }
    }

    addCommandHandler(command, handler) {
        if (handler) {
            this.commands[command] = handler;
        } else if (this.commands.hasOwnProperty(command)) {
            delete this.commands[command];
        }
    }

    getCommandHandler(command) {
        return this.commands[command];
    }

    __initCommandsCommon() {
        this.commands['authenticate'] = (socket, user, pass, callback) => {
            if (socket && socket.___socket) {
                socket = socket.___socket;
            }

            this.adapter.log.debug(`${new Date().toISOString()} Request authenticate [${socket._acl.user}]`);
            if (typeof user === 'function') {
                callback = user;
                // user = undefined;
            }
            if (socket._acl.user !== null) {
                if (typeof callback === 'function') {
                    callback(true, socket._secure);
                }
            } else {
                this.adapter.log.debug(`${new Date().toISOString()} Request authenticate [${socket._acl.user}]`);
                socket._authPending = callback;
            }
        };

        this.commands['error'] = (socket, err) => {
            this.adapter.log.error('Socket error: ' + err);
        };

        this.commands['log'] = (socket, text, level) => {
            if (level === 'error') {
                this.adapter.log.error(text);
            } else if (level === 'warn') {
                this.adapter.log.warn(text);
            } else if (level === 'info') {
                this.adapter.log.info(text);
            } else {
                this.adapter.log.debug(text);
            }
        };

        // new History
        this.commands['getHistory'] = (socket, id, options, callback) => {
            if (this._checkPermissions(socket, 'getStateHistory', callback, id)) {
                if (typeof options === 'string') {
                    options = {
                        instance: options
                    };
                }
                options = options || {};
                options.user = socket._acl.user;
                options.aggregate = options.aggregate || 'none';
                this.adapter.getHistory(id, options, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        // HTTP
        this.commands['httpGet'] = (socket, url, callback) => {
            if (this._checkPermissions(socket, 'httpGet', callback, url)) {
                axios = axios || require('axios');
                this.adapter.log.debug('httpGet: ' + url);
                try {
                    axios(url, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        validateStatus: status => status < 400
                    })
                        .then(result => callback(null, {status: result.status, statusText: result.statusText}, result.data))
                        .catch(error => callback(error));
                } catch (err) {
                    callback(err);
                }
            }
        };

        // commands
        this.commands['sendTo'] = (socket, adapterInstance, command, message, callback) => {
            if (this._checkPermissions(socket, 'sendTo', callback, command)) {
                this.adapter.sendTo(adapterInstance, command, message, res =>
                    typeof callback === 'function' && setImmediate(() =>
                        callback(res)));
            }
        };

        // following commands are protected and require the extra permissions
        const protectedCommands = ['cmdExec', 'getLocationOnDisk', 'getDiagData', 'getDevList', 'delLogs', 'writeDirAsZip', 'writeObjectsAsZip', 'readObjectsAsZip', 'checkLogging', 'updateMultihost', 'rebuildAdapter'];

        this.commands['sendToHost'] = (socket, host, command, message, callback) => {
            // host can answer following commands: cmdExec, getRepository, getInstalled, getInstalledAdapter, getVersion, getDiagData, getLocationOnDisk, getDevList, getLogs, getHostInfo,
            // delLogs, readDirAsZip, writeDirAsZip, readObjectsAsZip, writeObjectsAsZip, checkLogging, updateMultihost
            if (this._checkPermissions(socket, protectedCommands.includes(command) ? 'cmdExec' : 'sendToHost', callback, command)) {
                // Try to decode this file locally as redis has a limitation for files bigger than 20MB
                if (command === 'writeDirAsZip' && message && message.data.length > 1024 * 1024) {
                    if (!zipFiles) {
                        const utils = require('@iobroker/adapter-core'); // Get common adapter utils
                        zipFiles = require(utils.controllerDir + '/lib/zipFiles.js');
                    }
                    zipFiles
                        .writeDirAsZip(
                            this.adapter, // normally we have to pass here the internal "objects" object, but as
                            // only writeFile is used, and it has the same name we can pass here the
                            // adapter, which has the function with the same name and arguments
                            message.id,
                            message.name,
                            Buffer.from(message.data, 'base64'),
                            message.options,
                            error => callback({ error }) // this is for back compatibility with js-controller@4.0 or older
                        )
                        .then(() => callback({}))
                        .catch(error => {
                            this.adapter.log.error(`Cannot write zip file as folder: ${error}`);
                            callback({ error });
                        });
                } else if (this._sendToHost) {
                    this._sendToHost(host, command, message, callback);
                } else {
                    this.adapter.sendToHost(host, command, message, callback);
                }
            }
        };

        this.commands['authEnabled'] = (socket, callback) => {
            if (this._checkPermissions(socket, 'authEnabled', callback)) {
                if (typeof callback === 'function') {
                    callback(this.adapter.config.auth, (socket._acl.user || '').replace(/^system\.user\./, ''));
                } else {
                    this.adapter.log.warn('[authEnabled] Invalid callback');
                }
            }
        };

        this.commands['logout'] = (socket, callback) => {
            this.adapter.destroySession(socket._sessionID, callback);
        };

        this.commands['listPermissions'] = (socket, callback) => {
            if (typeof callback === 'function') {
                callback(SocketCommands.COMMANDS_PERMISSIONS);
            } else {
                this.adapter.log.warn('[listPermissions] Invalid callback');
            }
        };

        this.commands['getUserPermissions'] = (socket, callback) => {
            if (this._checkPermissions(socket, 'getUserPermissions', callback)) {
                if (typeof callback === 'function') {
                    callback(null, socket._acl);
                } else {
                    this.adapter.log.warn('[getUserPermissions] Invalid callback');
                }
            }
        };

        this.commands['getVersion'] = (socket, callback) => {
            if (this._checkPermissions(socket, 'getVersion', callback)) {
                if (typeof callback === 'function') {
                    callback(null, this.adapter.version, this.adapter.name);
                } else {
                    this.adapter.log.warn('[getVersion] Invalid callback');
                }
            }
        };

        this.commands['getAdapterName'] = (socket, callback) => {
            if (this._checkPermissions(socket, 'getAdapterName', callback)) {
                if (typeof callback === 'function') {
                    callback(null, this.adapter.name || 'unknown');
                } else {
                    this.adapter.log.warn('[getAdapterName] Invalid callback');
                }
            }
        };

    }

    __initCommandsFiles() {
        // file operations
        this.commands['readFile'] = (socket, _adapter, fileName, callback) => {
            if (this._checkPermissions(socket, 'readFile', callback, fileName)) {
                this.adapter.readFile(_adapter, fileName, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['readFile64'] = (socket, _adapter, fileName, callback) => {
            if (this._checkPermissions(socket, 'readFile64', callback, fileName)) {
                this.adapter.readFile(_adapter, fileName, {user: socket._acl.user}, (err, buffer, type) => {
                    let data64;
                    if (buffer) {
                        if (type === 'application/json') {
                            data64 = Buffer.from(encodeURIComponent(buffer)).toString('base64');
                        } else {
                            if (typeof buffer === 'string') {
                                data64 = Buffer.from(buffer).toString('base64');
                            } else {
                                data64 = buffer.toString('base64');
                            }
                        }
                    }

                    //Convert buffer to base 64
                    if (typeof callback === 'function') {
                        callback(err, data64 || '', type);
                    } else {
                        this.adapter.log.warn('[readFile64] Invalid callback');
                    }
                });
            }
        };

        this.commands['writeFile64'] = (socket, _adapter, fileName, data64, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {user: socket._acl.user};
            }

            options = options || {};
            options.user = socket._acl.user;

            if (this._checkPermissions(socket, 'writeFile64', callback, fileName)) {
                if (!data64) {
                    return typeof callback === 'function' && callback('No data provided');
                }
                // Convert base 64 to buffer
                const buffer = Buffer.from(data64, 'base64');
                this.adapter.writeFile(_adapter, fileName, buffer, options, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        // this function is overloaded in admin (because admin accepts only base64)
        this.commands['writeFile'] = (socket, _adapter, fileName, data, options, callback) => {
            if (this._checkPermissions(socket, 'writeFile', callback, fileName)) {
                if (typeof options === 'function') {
                    callback = options;
                    options = {user: socket._acl.user};
                }
                options = options || {};
                options.user = socket._acl.user;
                this.adapter.log.debug('writeFile deprecated. Please use writeFile64');
                // const buffer = Buffer.from(data64, 'base64');
                this.adapter.writeFile(_adapter, fileName, data, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['unlink'] = (socket, _adapter, name, callback) => {
            if (this._checkPermissions(socket, 'unlink', callback, name)) {
                this._unlink(_adapter, name, {user: socket._acl.user})
                    .then(() => callback && callback())
                    .catch(error => callback && callback(error));
            }
        };

        this.commands['deleteFile'] = (socket, _adapter, name, callback) => {
            if (this._checkPermissions(socket, 'unlink', callback, name)) {
                this.adapter.unlink(_adapter, name, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['deleteFolder'] = (socket, _adapter, name, callback) => {
            if (this._checkPermissions(socket, 'unlink', callback, name)) {
                this._unlink(_adapter, name, {user: socket._acl.user})
                    .then(() => SocketCommands._fixCallback(callback, null))
                    .catch(err => SocketCommands._fixCallback(callback, err));
            }
        };

        this.commands['renameFile'] = (socket, _adapter, oldName, newName, callback) => {
            if (this._checkPermissions(socket, 'rename', callback, oldName)) {
                this.adapter.rename(_adapter, oldName, newName, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['rename'] = (socket, _adapter, oldName, newName, callback) => {
            if (this._checkPermissions(socket, 'rename', callback, oldName)) {
                this._rename(_adapter, oldName, newName, {user: socket._acl.user})
                    .then(() => callback && callback())
                    .catch(error => callback && callback(error));
            }
        };

        this.commands['mkdir'] = (socket, _adapter, dirName, callback) => {
            if (this._checkPermissions(socket, 'mkdir', callback, dirName)) {
                this.adapter.mkdir(_adapter, dirName, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['readDir'] = (socket, _adapter, dirName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (options.filter === undefined) {
                options.filter = true;
            }

            if (this._checkPermissions(socket, 'readDir', callback, dirName)) {
                this.adapter.readDir(_adapter, dirName, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['chmodFile'] = (socket, _adapter, fileName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (options.filter === undefined) {
                options.filter = true;
            }

            if (this._checkPermissions(socket, 'chmodFile', callback, fileName)) {
                this.adapter.chmodFile(_adapter, fileName, options, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['chownFile'] = (socket, _adapter, fileName, options, callback) => {
            if (this._checkPermissions(socket, 'chownFile', callback, fileName)) {
                options = options || {};
                options.user = socket._acl.user;
                this.adapter.chownFile(_adapter, fileName, options, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['fileExists'] = (socket, _adapter, fileName, callback) => {
            if (this._checkPermissions(socket, 'fileExists', callback, fileName)) {
                this.adapter.fileExists(_adapter, fileName, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['subscribeFiles'] = (socket, id, pattern, callback) => this._subscribeFiles(socket, id, pattern, callback);

        this.commands['unsubscribeFiles'] = (socket, id, pattern, callback) => this._unsubscribeFiles(socket, id, pattern, callback);

        this.commands['getAdapterInstances'] = (socket, adapterName, callback) => {
            if (typeof callback === 'function') {
                if (this._checkPermissions(socket, 'getObject', callback)) {
                    let _adapterName = adapterName !== undefined && adapterName !== null ? adapterName : this.adapterName || '';
                    if (_adapterName) {
                        _adapterName += '.';
                    }
                    this.adapter.getObjectView('system', 'instance',
                        {startkey: `system.adapter.${_adapterName}`, endkey: `system.adapter.${_adapterName}\u9999`},
                        (err, doc) => {
                            if (err) {
                                callback(err);
                            } else {
                                callback(null, doc.rows
                                    .map(item => {
                                        const obj = item.value;
                                        if (obj.common) {
                                            delete obj.common.news;
                                        }
                                        this._fixAdminUI(obj);
                                        return obj;
                                    })
                                    .filter(obj => obj && (!adapterName || (obj.common && obj.common.name === adapterName))));
                            }
                        });
                }
            }
        };
    }

    __initCommandsStates() {
        this.commands['getStates'] = (socket, pattern, callback) => {
            if (this._checkPermissions(socket, 'getStates', callback, pattern)) {
                if (typeof pattern === 'function') {
                    callback = pattern;
                    pattern = null;
                }
                if (typeof callback === 'function') {
                    this.adapter.getForeignStates(pattern || '*', {user: socket._acl.user}, (err, ...args) =>
                        SocketCommands._fixCallback(callback, err, ...args));
                } else {
                    this.adapter.log.warn('[getStates] Invalid callback')
                }
            }
        };

        // this function is overloaded in admin
        this.commands['delObject'] = (socket, id, options, callback) => {
            // only flot allowed
            if (id.startsWith('flot.')) {
                if (this._checkPermissions(socket, 'delObject', callback, id)) {
                    this.adapter.delForeignObject(id, {user: socket._acl.user}, callback);
                }
            } else {
                if (typeof callback === 'function') {
                    callback(SocketCommands.ERROR_PERMISSION);
                }
            }
        };

        this.commands['getState'] = (socket, id, callback) => {
            if (this._checkPermissions(socket, 'getState', callback, id)) {
                if (typeof callback === 'function') {
                    if (this.states && this.states[id]) {
                        callback(null, this.states[id]);
                    } else {
                        this.adapter.getForeignState(id, {user: socket._acl.user}, (err, ...args) =>
                            SocketCommands._fixCallback(callback, err, ...args));
                    }
                } else {
                    this.adapter.log.warn('[getState] Invalid callback');
                }
            }
        };

        this.commands['setState'] = (socket, id, state, callback) => {
            if (this._checkPermissions(socket, 'setState', callback, id)) {
                if (typeof state !== 'object') {
                    state = {val: state};
                }

                // clear cache
                if (this.states && this.states[id]) {
                    delete this.states[id];
                }

                this.adapter.setForeignState(id, state, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };

        this.commands['getBinaryState'] = (socket, id, callback) => {
            if (this._checkPermissions(socket, 'getState', callback, id)) {
                if (typeof callback === 'function') {
                    if (this.adapter.getForeignBinaryState) {
                        this.adapter.getForeignBinaryState(id, (err, data) => {
                            if (data) {
                                data = Buffer.from(data).toString('base64');
                            }
                            SocketCommands._fixCallback(callback, err, data);
                        });
                    } else {
                        this.adapter.getBinaryState(id, (err, data) => {
                            if (data) {
                                data = Buffer.from(data).toString('base64');
                            }
                            SocketCommands._fixCallback(callback, err, data);
                        });
                    }
                } else {
                    this.adapter.log.warn('[getBinaryState] Invalid callback')
                }
            }
        };

        this.commands['setBinaryState'] = (socket, id, base64, callback) => {
            if (this._checkPermissions(socket, 'setState', callback, id)) {
                if (typeof callback === 'function') {
                    let data = null;
                    try {
                        data = Buffer.from(base64, 'base64')
                    } catch (e) {
                        this.adapter.log.warn('[setBinaryState] Cannot convert base64 data: ' + e);
                    }

                    if (this.adapter.setForeignBinaryState) {
                        this.adapter.setForeignBinaryState(id, data, (err, ...args) =>
                            SocketCommands._fixCallback(callback, err, ...args));
                    } else {
                        this.adapter.setBinaryState(id, data, (err, ...args) =>
                            SocketCommands._fixCallback(callback, err, ...args));
                    }
                } else {
                    this.adapter.log.warn('[setBinaryState] Invalid callback');
                }
            }
        };

        this.commands['subscribe'] = (socket, pattern, callback) => this._subscribeStates(socket, pattern, callback);
        this.commands['subscribeStates'] = (socket, pattern, callback) => this._subscribeStates(socket, pattern, callback);

        this.commands['unsubscribe'] = (socket, pattern, callback) => this._unsubscribeStates(socket, pattern, callback);
        this.commands['unsubscribeStates'] = (socket, pattern, callback) => this._unsubscribeStates(socket, pattern, callback);
    }

    __initCommandsObjects() {
        this.commands['getObject'] = (socket, id, callback) => {
            if (this._checkPermissions(socket, 'getObject', callback, id)) {
                this.adapter.getForeignObject(id, {user: socket._acl.user}, (err, obj) => {
                    // overload language from current instance
                    if (this.adapter._language && id === 'system.config' && obj.common) {
                        obj.common.language = this.adapter._language;
                    }
                    SocketCommands._fixCallback(callback, err, obj);
                });
            }
        };

        // not admin version of "all objects"
        this.commands['getObjects'] = (socket, callback) => {
            if (this._checkPermissions(socket, 'getObjects', callback)) {
                this.adapter.getForeignObjects('*', 'state', 'rooms', {user: socket._acl.user}, (err, objs) => {
                    if (typeof callback === 'function') {
                        // overload language
                        if (this.adapter._language && objs['system.config'] && objs['system.config'].common) {
                            objs['system.config'].common.language = this.adapter._language;
                        }

                        callback(err, objs);
                    } else {
                        this.adapter.log.warn('[getObjects] Invalid callback');
                    }
                });
            }
        };

        this.commands['subscribeObjects'] = (socket, pattern, callback) => {
            if (this._checkPermissions(socket, 'subscribeObjects', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        this.subscribe(socket, 'objectChange', pattern[p]);
                    }
                } else {
                    this.subscribe(socket, 'objectChange', pattern);
                }
                if (typeof callback === 'function') {
                    setImmediate(callback, null);
                }
            }
        };

        this.commands['unsubscribeObjects'] = (socket, pattern, callback) => {
            if (this._checkPermissions(socket, 'unsubscribeObjects', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        this.unsubscribe(socket, 'objectChange', pattern[p]);
                    }
                } else {
                    this.unsubscribe(socket, 'objectChange', pattern);
                }
                if (typeof callback === 'function') {
                    setImmediate(callback, null);
                }
            }
        };

        this.commands['getObjectView'] = (socket, design, search, params, callback) => {
            if (typeof callback === 'function') {
                if (this._checkPermissions(socket, 'getObjectView', callback, search)) {
                    this.adapter.getObjectView(design, search, params, {user: socket._acl.user}, callback);
                }
            } else {
                this.adapter.log.error('Callback is not a function');
            }
        };

        this.commands['setObject'] = (socket, id, obj, callback) => {
            if (this._checkPermissions(socket, 'setObject', callback, id)) {
                this.adapter.setForeignObject(id, obj, {user: socket._acl.user}, (err, ...args) =>
                    SocketCommands._fixCallback(callback, err, ...args));
            }
        };
    }

    _initCommands() {
        this.__initCommandsCommon();
        this.__initCommandsObjects();
        this.__initCommandsStates();
        this.__initCommandsFiles();
    }

    applyCommands(socket) {
        Object.keys(this.commands)
            .forEach(command => socket.on(command, (...args) => {
                if (this._updateSession(socket)) {
                    this.commands[command](socket, ...args);
                }
            }));
    }

    destroy() {
        // could be overloaded
    }
}

module.exports = SocketCommands;
