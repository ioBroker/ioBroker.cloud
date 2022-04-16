/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jshint -W061 */
'use strict';

const path         = require('path');
const fs           = require('fs');
const cookieParser = require('cookie-parser');
const EventEmitter = require('events');
const util         = require('util');
const WebSocket    = require('ws');
let request        = null;

// From settings used only secure, auth and crossDomain
function IOSocket(server, settings, adapter) {
    if (!(this instanceof IOSocket)) {
        return new IOSocket(server, settings, adapter);
    }

    this.settings          = settings || {};
    this.adapter           = adapter;
    this.webServer         = server;
    this.subscribes        = {};
    this.commands          = {};
    this.lovelaceSockets   = {};
    this.secret            = null;
    this.infoTimeout       = null;

    const CLIENT_MODE = !!this.settings.apikey;

    let that = this;
// do not send too many state updates
    let eventsThreshold = {
        count:          0,
        timeActivated:  0,
        active:         false,
        accidents:      0,
        repeatSeconds:  3,   // how many seconds continuously must be number of events > value
        value:          200, // how many events allowed in one check interval
        checkInterval:  1000 // duration of one check interval
    };

    function fixAdminUI(obj) {
        if (obj && obj.common && !obj.common.adminUI) {
            if (obj.common.noConfig) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.config = 'none';
            } else if (obj.common.jsonConfig) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.config = 'json';
            } else if (obj.common.materialize) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.config = 'materialize';
            } else {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.config = 'html';
            }

            if (obj.common.jsonCustom) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.custom = 'json';
            } else if (obj.common.supportCustoms) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.custom = 'json';
            }

            if (obj.common.materializeTab && obj.common.adminTab) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.tab = 'materialize';
            } else if (obj.common.adminTab) {
                obj.common.adminUI = obj.common.adminUI || {};
                obj.common.adminUI.tab = 'html';
            }

            obj.common.adminUI && adapter.log.debug(`Please add to "${obj._id.replace(/\.\d+$/, '')}" common.adminUI=${JSON.stringify(obj.common.adminUI)}`);
        }
    }

    // Extract user name from socket
    function getUserFromSocket(socket, callback) {
        let wait = false;
        try {
            if (socket.handshake.headers.cookie && (!socket.request || !socket.request._query || !socket.request._query.user)) {
                const cookie = decodeURIComponent(socket.handshake.headers.cookie);
                const m = cookie.match(/connect\.sid=(.+)/);
                if (m) {
                    // If session cookie exists
                    const c = m[1].split(';')[0];
                    const sessionID = cookieParser.signedCookie(c, that.settings.secret);
                    if (sessionID) {
                        // Get user for session
                        wait = true;
                        that.settings.store.get(sessionID, function (err, obj) {
                            if (obj && obj.passport && obj.passport.user) {
                                socket._sessionID = sessionID;
                                if (typeof callback === 'function') {
                                    callback(null, obj.passport.user);
                                } else {
                                    that.adapter.log.warn('[getUserFromSocket] Invalid callback')
                                }
                            } else {
                                if (typeof callback === 'function') {
                                    callback('unknown user');
                                } else {
                                    that.adapter.log.warn('[getUserFromSocket] Invalid callback')
                                }
                            }
                        });
                    }
                }
            }

            if (!wait) {
                const user = socket.request._query.user;
                const pass = socket.request._query.pass;
                if (user && pass) {
                    wait = true;
                    that.adapter.checkPassword(user, pass, function (res) {
                        if (res) {
                            that.adapter.log.debug('Logged in: ' + user);
                            if (typeof callback === 'function') {
                                callback(null, user);
                            } else {
                                that.adapter.log.warn('[getUserFromSocket] Invalid callback')
                            }
                        } else {
                            that.adapter.log.warn(`Invalid password or user name: ${user}, ${pass[0]}***(${pass.length})`);
                            if (typeof callback === 'function') {
                                callback('unknown user');
                            } else {
                                that.adapter.log.warn('[getUserFromSocket] Invalid callback')
                            }
                        }
                    });
                }
            }
        } catch (e) {
            that.adapter.log.error(e);
            wait = false;
        }

        if (!wait && typeof callback === 'function') {
            callback('Cannot detect user');
        }
    }

    function disableEventThreshold(readAll) {
        if (eventsThreshold.active) {
            eventsThreshold.accidents = 0;
            eventsThreshold.count = 0;
            eventsThreshold.active = false;
            eventsThreshold.timeActivated = 0;
            that.adapter.log.info('Subscribe on all states again');

            /*setTimeout(function () {
                if (readAll) {
                    that.adapter.getForeignStates('*', function (err, res) {
                        that.adapter.log.info('received all states');
                        for (var id in res) {
                            if (res.hasOwnProperty(id) && JSON.stringify(states[id]) !== JSON.stringify(res[id])) {
                                that.server.sockets.emit('stateChange', id, res[id]);
                                states[id] = res[id];
                            }
                        }
                    });
                }

                that.server.sockets.emit('eventsThreshold', false);
                that.adapter.unsubscribeForeignStates('system.adapter.*');
                that.adapter.subscribeForeignStates('*');
            }, 50);*/
        }
    }

    function enableEventThreshold() {
        if (!eventsThreshold.active) {
            eventsThreshold.active = true;

            /*setTimeout(function () {
                that.adapter.log.info('Unsubscribe from all states, except system\'s, because over ' + eventsThreshold.repeatSeconds + ' seconds the number of events is over ' + eventsThreshold.value + ' (in last second ' + eventsThreshold.count + ')');
                eventsThreshold.timeActivated = Date.now();

                that.server.sockets.emit('eventsThreshold', true);
                that.adapter.unsubscribeForeignStates('*');
                that.adapter.subscribeForeignStates('system.adapter.*');
            }, 100);*/
        }
    }

    function getClientAddress(socket) {
        let address;
        if (socket.handshake) {
            address = socket.handshake.address;
        }
        if (!address && socket.request && socket.request.connection) {
            address = socket.request.connection.remoteAddress;
        }
        return address;
    }

    this.initSocket = function (socket) {
        if (that.adapter.config.auth) {
            getUserFromSocket(socket, (err, user) => {
                if (err || !user) {
                    socket.emit('reauthenticate');
                    that.adapter.log.error('socket.io ' + err);
                    socket.disconnect();
                } else {
                    socket._secure = true;
                    that.adapter.log.debug(`socket.io client ${user} connected`);
                    that.adapter.calculatePermissions('system.user.' + user, commandsPermissions, acl => {
                        const address = getClientAddress(socket);
                        // socket._acl = acl;
                        socket._acl = mergeACLs(address, acl, that.settings.whiteListSettings);
                        socketEvents(socket, address);
                    });
                }
            });
        } else {
            that.adapter.calculatePermissions(that.adapter.config.defaultUser, commandsPermissions, acl => {
                const address = getClientAddress(socket);
                // socket._acl = acl;
                socket._acl = mergeACLs(address, acl, that.settings.whiteListSettings);
                socketEvents(socket, address);
            });
        }
    };

    this.getWhiteListIpForAddress = function (address, whiteList) {
        return getWhiteListIpForAddress(address, whiteList);
    };

    function getWhiteListIpForAddress(address, whiteList) {
        if (!whiteList) return null;

        // check IPv6 or IPv4 direct match
        if (whiteList.hasOwnProperty(address)) {
            return address;
        }

        // check if address is IPv4
        const addressParts = address.split('.');
        if (addressParts.length !== 4) {
            return null;
        }

        // do we have settings for wild carded ips?
        const wildCardIps = Object.keys(whiteList).filter(function (key) {
            return key.includes('*');
        });


        if (wildCardIps.length === 0) {
            // no wild carded ips => no ip configured
            return null;
        }

        wildCardIps.forEach(function (ip) {
            const ipParts = ip.split('.');
            if (ipParts.length === 4) {
                for (let i = 0; i < 4; i++) {
                    if (ipParts[i] === '*' && i === 3) {
                        // match
                        return ip;
                    }

                    if (ipParts[i] !== addressParts[i]) {
                        break;
                    }
                }
            }
        });

        return null;
    }

    function getPermissionsForIp(address, whiteList) {
        return whiteList[getWhiteListIpForAddress(address, whiteList) || 'default'];
    }

    function mergeACLs(address, acl, whiteList) {
        if (whiteList && address) {
            const whiteListAcl = getPermissionsForIp(address, whiteList);
            if (whiteListAcl) {
                ['object', 'state', 'file'].forEach(key => {
                    if (acl.hasOwnProperty(key) && whiteListAcl.hasOwnProperty(key)) {
                        Object.keys(acl[key]).forEach(permission => {
                            if (whiteListAcl[key].hasOwnProperty(permission)) {
                                acl[key][permission] = acl[key][permission] && whiteListAcl[key][permission];
                            }
                        })
                    }
                });

                if (whiteListAcl.user !== 'auth') {
                    acl.user = 'system.user.' + whiteListAcl.user;
                }
            }
        }

        return acl;
    }

    function pattern2RegEx(pattern) {
        if (!pattern) {
            return null;
        }
        if (pattern !== '*') {
            if (pattern[0] === '*' && pattern[pattern.length - 1] !== '*') {
                pattern += '$';
            }
            if (pattern[0] !== '*' && pattern[pattern.length - 1] === '*') {
                pattern = '^' + pattern;
            }
        }
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\*/g, '.*');
        pattern = pattern.replace(/\[/g, '\\[');
        pattern = pattern.replace(/]/g, '\\]');
        pattern = pattern.replace(/\(/g, '\\(');
        pattern = pattern.replace(/\)/g, '\\)');
        return pattern;
    }

    this.subscribe = function (socket, type, pattern) {
        if (socket) {
            socket._subscribe = socket._subscribe || {};
        }

        this.subscribes[type] = this.subscribes[type] || {};

        let s;
        if (socket) {
            socket._subscribe[type] = socket._subscribe[type] || [];
            s = socket._subscribe[type];

            if (s.find(so => so.pattern === pattern)) {
                return;
            }
        }

        if (typeof pattern !== 'string') {
            this.adapter.log.warn(`Subscribe: Pattern should be a string but ${typeof pattern} provided.`);
            return;
        }
        const p = pattern2RegEx(pattern);
        if (p === null) {
            this.adapter.log.warn('Empty pattern!');
            return;
        }

        socket && s.push({pattern: pattern, regex: new RegExp(p)});
        if (this.subscribes[type][pattern] === undefined) {
            this.subscribes[type][pattern] = 1;
            if (type === 'stateChange') {
                this.adapter.subscribeForeignStates && this.adapter.subscribeForeignStates(pattern);
            } else if (type === 'objectChange') {
                this.adapter.subscribeForeignObjects && this.adapter.subscribeForeignObjects(pattern);
            } else if (type === 'log') {
                this.adapter.requireLog && this.adapter.requireLog(true);
            }
        } else {
            this.subscribes[type][pattern]++;
        }
    };

    function showSubscribes(socket, type) {
        if (socket && socket._subscribe) {
            const s = socket._subscribe[type] || [];
            let ids = [];
            for (let i = 0; i < s.length; i++) {
                ids.push(s[i].pattern);
            }
            that.adapter.log.debug('Subscribes: ' + ids.join(', '));
        } else {
            that.adapter.log.debug('Subscribes: no subscribes');
        }
    }

    this.unsubscribe = function (socket, type, pattern) {
        this.subscribes[type] = this.subscribes[type] || {};

        if (socket) {
            if (!socket._subscribe || !socket._subscribe[type]) {
                return;
            }
            for (let i = socket._subscribe[type].length - 1; i >= 0; i--) {
                if (socket._subscribe[type][i].pattern === pattern) {

                    // Remove pattern from global list
                    if (this.subscribes[type][pattern] !== undefined) {
                        this.subscribes[type][pattern]--;
                        if (this.subscribes[type][pattern] <= 0) {
                            if (type === 'stateChange') {
                                //console.log((socket._name || socket.id) + ' unsubscribeForeignStates ' + pattern);
                                this.adapter.unsubscribeForeignStates && this.adapter.unsubscribeForeignStates(pattern);
                            } else if (type === 'objectChange') {
                                //console.log((socket._name || socket.id) + ' unsubscribeForeignObjects ' + pattern);
                                this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                            } else if (type === 'log') {
                                //console.log((socket._name || socket.id) + ' requireLog false');
                                this.adapter.requireLog && this.adapter.requireLog(false);
                            }
                            delete this.subscribes[type][pattern];
                        }
                    }

                    delete socket._subscribe[type][i];
                    socket._subscribe[type].splice(i, 1);
                    return;
                }
            }
        } else if (pattern) {
            // Remove pattern from global list
            if (this.subscribes[type][pattern] !== undefined) {
                this.subscribes[type][pattern]--;
                if (this.subscribes[type][pattern] <= 0) {
                    if (type === 'stateChange') {
                        //console.log((socket._name || socket.id) + ' unsubscribeForeignStates ' + pattern);
                        this.adapter.unsubscribeForeignStates && this.adapter.unsubscribeForeignStates(pattern);
                    } else if (type === 'objectChange') {
                        //console.log((socket._name || socket.id) + ' unsubscribeForeignObjects ' + pattern);
                        this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                    } else if (type === 'log') {
                        //console.log((socket._name || socket.id) + ' requireLog false');
                        this.adapter.requireLog && this.adapter.requireLog(false);
                    }
                    delete this.subscribes[type][pattern];
                }
            }
        } else {
            for (pattern in this.subscribes[type]) {
                if (!this.subscribes[type].hasOwnProperty(pattern)) continue;
                if (type === 'stateChange') {
                    //console.log((socket._name || socket.id) + ' unsubscribeForeignStates ' + pattern);
                    this.adapter.unsubscribeForeignStates && this.adapter.unsubscribeForeignStates(pattern);
                } else if (type === 'objectChange') {
                    //console.log((socket._name || socket.id) + ' unsubscribeForeignObjects ' + pattern);
                    this.adapter.unsubscribeForeignObjects && this.adapter.unsubscribeForeignObjects(pattern);
                } else if (type === 'log') {
                    //console.log((socket._name || socket.id) + ' requireLog false');
                    this.adapter.requireLog && this.adapter.requireLog(false);
                }
                delete this.subscribes[type][pattern];
            }
        }
    };

    /*this.unsubscribeAll = function () {
        if (this.server && this.server.sockets) {
            for (let s in this.server.sockets) {
                if (this.server.sockets.hasOwnProperty(s)) {
                    unsubscribeSocket(s, 'stateChange');
                    unsubscribeSocket(s, 'objectChange');
                    unsubscribeSocket(s, 'log');
                }
            }
        }
    };*/

    function unsubscribeSocket(socket, type) {
        if (socket._subSockets) {
            // go through sub-sockets
            Object.keys(socket._subSockets)
                .forEach(subSocketID => {
                    unsubscribeSocket(socket._subSockets[subSocketID], type);

                    // delete types if empty
                    const subscribe = socket._subSockets[subSocketID]._subscribe;
                    if (subscribe) {
                        Object.keys(subscribe).forEach(type =>
                            (!subscribe[type] || !subscribe[type].length) && delete subscribe[type]);
                    }

                    // remove socket if anyway no subscriptions exists
                    if (!subscribe || !Object.keys(subscribe).some(type => subscribe[type] && subscribe[type].length)) {
                        delete socket._subSockets[subSocketID]._subscribe;
                        delete socket._subSockets[subSocketID];
                    }
                });
        } else {
            if (!socket._subscribe || !socket._subscribe[type] || !socket._subscribe[type].length) {
                return;
            }

            for (let i = 0; i < socket._subscribe[type].length; i++) {
                const pattern = socket._subscribe[type][i].pattern;

                if (that.subscribes[type][pattern] !== undefined) {
                    that.subscribes[type][pattern]--;
                    if (that.subscribes[type][pattern] <= 0) {
                        if (type === 'stateChange') {
                            that.adapter.unsubscribeForeignStates && that.adapter.unsubscribeForeignStates(pattern);
                        } else if (type === 'objectChange') {
                            that.adapter.unsubscribeForeignObjects && that.adapter.unsubscribeForeignObjects(pattern);
                        } else if (type === 'log') {
                            that.adapter.requireLog && that.adapter.requireLog(false);
                        }
                        delete that.subscribes[type][pattern];
                    }
                }
            }

            // if client mode
            if (!socket.conn) {
                // all unsubscribed, so
                socket._subscribe[type] = [];
            }
        }
    }

    function subscribeSocket(socket, type) {
        if (socket._subSockets) {
            // go through sub-sockets
            Object.keys(socket._subSockets)
                .forEach(subSocketID =>
                    subscribeSocket(socket._subSockets[subSocketID], type));
        } else {
            //console.log((socket._name || socket.id) + ' subscribeSocket');
            if (!socket._subscribe || !socket._subscribe[type] || !socket._subscribe[type].length) {
                return;
            }

            for (let i = 0; i < socket._subscribe[type].length; i++) {
                const pattern = socket._subscribe[type][i].pattern;
                if (that.subscribes[type][pattern] === undefined) {
                    that.subscribes[type][pattern] = 1;
                    if (type === 'stateChange') {
                        that.adapter.subscribeForeignStates && that.adapter.subscribeForeignStates(pattern);
                    } else if (type === 'objectChange') {
                        that.adapter.subscribeForeignObjects && that.adapter.subscribeForeignObjects(pattern);
                    } else if (type === 'log') {
                        that.adapter.requireLog && that.adapter.requireLog(true);
                    }
                } else {
                    that.subscribes[type][pattern]++;
                }
            }
        }
    }

    /*
    function publish(socket, type, id, obj) {
        if (!socket._subscribe || !socket._subscribe[type]) {
            return;
        }

        const s = socket._subscribe[type];

        for (let i = 0; i < s.length; i++) {
            if (s[i].regex.test(id)) {
                updateSession(socket);
                socket.emit(type, id, obj);
                return;
            }
        }
    }
    */
    // update session ID, but not oftener than 60 seconds
    function updateSession(socket) {
        if (socket && socket.___socket) {
            socket = socket.___socket;
        }
        if (socket._sessionID) {
            const time = Date.now();
            if (socket._lastActivity && time - socket._lastActivity > settings.ttl * 1000) {
                socket.emit('reauthenticate');
                socket.disconnect();
                return false;
            }

            socket._lastActivity = time;

            if (!socket._sessionTimer) {
                socket._sessionTimer = setTimeout(() => {
                    socket._sessionTimer = null;
                    that.settings.store.get(socket._sessionID,  (err, obj) => {
                        if (obj) {
                            that.adapter.setSession(socket._sessionID, settings.ttl, obj);
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

    // static information
    const commandsPermissions = {
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

        createFile:         {type: 'file',      operation: 'create'},
        writeFile:          {type: 'file',      operation: 'write'},
        readFile:           {type: 'file',      operation: 'read'},
        deleteFile:         {type: 'file',      operation: 'delete'},
        readFile64:         {type: 'file',      operation: 'read'},
        writeFile64:        {type: 'file',      operation: 'write'},
        unlink:             {type: 'file',      operation: 'delete'},
        rename:             {type: 'file',      operation: 'write'},
        mkdir:              {type: 'file',      operation: 'write'},
        readDir:            {type: 'file',      operation: 'list'},
        chmodFile:          {type: 'file',      operation: 'write'},

        authEnabled:        {type: '',          operation: ''},
        disconnect:         {type: '',          operation: ''},
        listPermissions:    {type: '',          operation: ''},
        getUserPermissions: {type: 'object',    operation: 'read'}
    };

    function addUser(user, pw, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }

        if (!user.match(/^[-.A-Za-züäößÖÄÜа-яА-Я@+$§0-9=?!&# ]+$/)) {
            if (typeof callback === 'function') {
                callback('Invalid characters in the name. Only following special characters are allowed: -@+$§=?!&# and letters');
            }
            return;
        }

        that.adapter.getForeignObject('system.user.' + user, options, (err, obj) => {
            if (obj) {
                typeof callback === 'function' && callback('User yet exists');
            } else {
                that.adapter.setForeignObject('system.user.' + user, {
                    type: 'user',
                    common: {
                        name: user,
                        enabled: true,
                        groups: []
                    }
                },
                options,
                () => that.adapter.setPassword(user, pw, callback));
            }
        });
    }

    function delUser(user, options, callback) {
        that.adapter.getForeignObject('system.user.' + user, options, function (err, obj) {
            if (err || !obj) {
                typeof callback === 'function' && callback('User does not exist');
            } else {
                if (obj.common.dontDelete) {
                    typeof callback === 'function' && callback('Cannot delete user, while is system user');
                } else {
                    that.adapter.delForeignObject('system.user.' + user, options, err =>
                        // Remove this user from all groups in web client
                        typeof callback === 'function' && callback(err));
                }
            }
        });
    }

    function addGroup(group, desc, acl, options, callback) {
        let name = group;
        if (typeof acl === 'function') {
            callback = acl;
            acl = null;
        }
        if (typeof desc === 'function') {
            callback = desc;
            desc = null;
        }
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (name && name.substring(0, 1) !== name.substring(0, 1).toUpperCase()) {
            name = name.substring(0, 1).toUpperCase() + name.substring(1);
        }
        group = group.substring(0, 1).toLowerCase() + group.substring(1);

        if (!group.match(/^[-.A-Za-züäößÖÄÜа-яА-Я@+$§0-9=?!&#_ ]+$/)) {
            return typeof callback === 'function' && callback('Invalid characters in the group name. Only following special characters are allowed: -@+$§=?!&# and letters');
        }

        that.adapter.getForeignObject('system.group.' + group, options, function (err, obj) {
            if (obj) {
                typeof callback === 'function' && callback('Group yet exists');
            } else {
                obj = {
                    _id:  'system.group.' + group,
                    type: 'group',
                    common: {
                        name: name,
                        desc: desc,
                        members: [],
                        acl: acl
                    }
                };
                that.adapter.setForeignObject('system.group.' + group, obj, options, err =>
                    typeof callback === 'function' && callback(err, obj));
            }
        });
    }

    function delGroup(group, options, callback) {
        that.adapter.getForeignObject('system.group.' + group, options, (err, obj) => {
            if (err || !obj) {
                typeof callback === 'function' && callback('Group does not exist');
            } else {
                if (obj.common.dontDelete) {
                    typeof callback === 'function' && callback('Cannot delete group, while is system group');
                } else {
                    that.adapter.delForeignObject('system.group.' + group, options, err =>
                        // Remove this group from all users in web client
                        typeof callback === 'function' && callback(err));
                }
            }
        });
    }

    function checkPermissions(socket, command, callback, arg) {
        if (socket && socket.___socket) {
            socket = socket.___socket;
        }
        if (socket._acl.user !== 'system.user.admin') {
            // type: file, object, state, other
            // operation: create, read, write, list, delete, sendto, execute, sendToHost, readLogs
            if (commandsPermissions[command]) {
                // If permission required
                if (commandsPermissions[command].type) {
                    if (socket._acl[commandsPermissions[command].type] &&
                        socket._acl[commandsPermissions[command].type][commandsPermissions[command].operation]) {
                        return true;
                    } else {
                        that.adapter.log.warn('No permission for "' + socket._acl.user + '" to call ' + command + '. Need "' + commandsPermissions[command].type + '"."' + commandsPermissions[command].operation + '"');
                    }
                } else {
                    return true;
                }
            } else {
                that.adapter.log.warn('No rule for command: ' + command);
            }

            if (typeof callback === 'function') {
                callback('permissionError');
            } else {
                if (commandsPermissions[command]) {
                    socket.emit('permissionError', {
                        command: command,
                        type: commandsPermissions[command].type,
                        operation: commandsPermissions[command].operation,
                        arg: arg
                    });
                } else {
                    socket.emit('permissionError', {
                        command: command,
                        arg: arg
                    });
                }
            }
            return false;
        } else {
            return true;
        }
    }

    function checkObject(obj, options, flag) {
        // read rights of object
        if (!obj || !obj.common || !obj.acl || flag === 'list') {
            return true;
        }

        if (options.user !== 'system.user.admin' &&
            !options.groups.includes('system.group.administrator')) {
            if (obj.acl.owner !== options.user) {
                // Check if the user is in the group
                if (options.groups.includes(obj.acl.ownerGroup)) {
                    // Check group rights
                    if (!(obj.acl.object & (flag << 4))) {
                        return false
                    }
                } else {
                    // everybody
                    if (!(obj.acl.object & flag)) {
                        return false
                    }
                }
            } else {
                // Check group rights
                if (!(obj.acl.object & (flag << 8))) {
                    return false
                }
            }
        }
        return true;
    }

    this.send = function (socket, cmd, id, data) {
        if (socket && socket.___socket) {
            socket = socket.___socket;
        }

        if (socket._apiKeyOk) {
            // send on all clients
            socket.emit(cmd, id, data);
        }
    };

    function stopAdapter(data) {
        that.adapter.log.warn('Adapter stopped. Reason: ' + (data && data.reason ? data.reason : 'command from server'));

        that.emit && that.emit('cloudStop');
    }

    function redirectAdapter(data) {
        that.emit && that.emit('cloudRedirect', data);
    }

    function waitForConnect(data) {
        that.emit && that.emit('connectWait', data ? data.delaySeconds || 30 : 30);
    }

    function initCommands() {
        that.commands.authenticate = function (socket, user, pass, callback) {
            if (socket && socket.___socket) {
                socket = socket.___socket;
            }

            that.adapter.log.debug((new Date()).toISOString() + ' Request authenticate [' + socket._acl.user + ']');

            if (typeof user === 'function') {
                callback = user;
                user = undefined; // delete from memory
            }
            if (socket._acl.user !== null) {
                typeof callback === 'function' && callback(!!socket._acl.user, socket._secure);
            } else {
                that.adapter.log.debug((new Date()).toISOString() + ' Request authenticate [' + socket._acl.user + ']');
                socket._authPending = callback;
            }
        };

        that.commands.name = function (socket, name) {
            updateSession(socket);

            if (socket._name === undefined) {
                socket._name = name;
                if (!that.infoTimeout) {
                    that.infoTimeout = setTimeout(updateConnectedInfo, 1000);
                }
            } else if (socket._name !== name) {
                that.adapter.log.debug('socket ' + socket.id + ' changed socket name from ' + socket._name + ' to ' + name);
                socket._name = name;
            }
        };

        /*
         *      objects
         */
        that.commands.getObject = function (socket, id, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getObject', callback, id)) {
                that.adapter.getForeignObject(id, {user: socket._acl.user}, callback);
            }
        };

        that.commands.getObjects = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getObjects', callback)) {
                that.adapter.getForeignObjects('*', 'state', 'rooms', {user: socket._acl.user}, function (err, objs) {
                    if (typeof callback === 'function') {
                        callback(err, objs);
                    } else {
                        that.adapter.log.warn('[getObjects] Invalid callback')
                    }
                });
            }
        };

        that.commands.subscribeObjects = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'subscribeObjects', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.subscribe(socket, 'objectChange', pattern[p]);
                    }
                } else {
                    that.subscribe(socket, 'objectChange', pattern);
                }
                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        that.commands.unsubscribeObjects = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unsubscribeObjects', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.unsubscribe(socket, 'objectChange', pattern[p]);
                    }
                } else {
                    that.unsubscribe(socket, 'objectChange', pattern);
                }
                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        that.commands.getObjectView = function (socket, design, search, params, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getObjectView', callback, search)) {
                that.adapter.getObjectView(design, search, params, {user: socket._acl.user}, callback);
            }
        };

        that.commands.setObject = function (socket, id, obj, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'setObject', callback, id)) {
                that.adapter.setForeignObject(id, obj, {user: socket._acl.user}, callback);
            }
        };

        /*
         *      states
         */
        that.commands.getStates = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getStates', callback, pattern)) {
                if (typeof pattern === 'function') {
                    callback = pattern;
                    pattern = null;
                }
                that.adapter.getForeignStates(pattern || '*', {user: socket._acl.user}, callback);
            }
        };

        // allow admin access
        if (that.settings.allowAdmin) {
            that.commands.getAllObjects = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObjects', callback)) {
                    that.adapter.getObjectList({include_docs: true}, function (err, res) {
                        that.adapter.log.info('received all objects');
                        res = res.rows;
                        let objects = {};

                        if (socket._acl &&
                            socket._acl.user !== 'system.user.admin' &&
                            !socket._acl.groups.includes('system.group.administrator')) {
                            for (let i = 0; i < res.length; i++) {
                                if (checkObject(res[i].doc, socket._acl, 4 /* 'read' */)) {
                                    objects[res[i].doc._id] = res[i].doc;
                                }
                            }
                            if (typeof callback === 'function') {
                                callback(null, objects);
                            } else {
                                that.adapter.log.warn('[getAllObjects] Invalid callback')
                            }
                        } else {
                            for (let j = 0; j < res.length; j++) {
                                objects[res[j].doc._id] = res[j].doc;
                            }
                            if (typeof callback === 'function') {
                                callback(null, objects);
                            } else {
                                that.adapter.log.warn('[getAllObjects] Invalid callback')
                            }
                        }
                    });
                }
            };

            that.commands.delObject = function (socket, id, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'delObject', callback, id)) {
                    that.adapter.delForeignObject(id, {user: socket._acl.user}, callback);
                }
            };

            that.commands.extendObject = function (socket, id, obj, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'extendObject', callback, id)) {
                    that.adapter.extendForeignObject(id, obj, {user: socket._acl.user}, callback);
                }
            };

            that.commands.getHostByIp = function (socket, ip, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getHostByIp', ip)) {
                    that.adapter.getObjectView('system', 'host', {}, {user: socket._acl.user}, function (err, data) {
                        if (data.rows.length) {
                            for (var i = 0; i < data.rows.length; i++) {
                                if (data.rows[i].value.common.hostname === ip) {
                                    if (typeof callback === 'function') {
                                        callback(ip, data.rows[i].value);
                                    } else {
                                        that.adapter.log.warn('[getHostByIp] Invalid callback')
                                    }
                                    return;
                                }
                                if (data.rows[i].value.native.hardware && data.rows[i].value.native.hardware.networkInterfaces) {
                                    const net = data.rows[i].value.native.hardware.networkInterfaces;
                                    for (let eth in net) {
                                        if (!net.hasOwnProperty(eth)) {
                                            continue;
                                        }
                                        for (let j = 0; j < net[eth].length; j++) {
                                            if (net[eth][j].address === ip) {
                                                if (typeof callback === 'function') {
                                                    callback(ip, data.rows[i].value);
                                                } else {
                                                    that.adapter.log.warn('[getHostByIp] Invalid callback')
                                                }
                                                return;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if (typeof callback === 'function') {
                            callback(ip, null);
                        } else {
                            that.adapter.log.warn('[getHostByIp] Invalid callback');
                        }
                    });
                }
            };

            that.commands.getForeignObjects = function (socket, pattern, type, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObjects', callback)) {
                    if (typeof type === 'function') {
                        callback = type;
                        type = undefined;
                    }

                    that.adapter.getForeignObjects(pattern, type, {user: socket._acl.user}, function (err, objs) {
                        if (typeof callback === 'function') {
                            callback(err, objs);
                        } else {
                            that.adapter.log.warn('[getObjects] Invalid callback');
                        }
                    });
                }
            };

            that.commands.getForeignStates = function (socket, pattern, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getStates', callback)) {
                    that.adapter.getForeignStates(pattern, function (err, objs) {
                        if (typeof callback === 'function') {
                            callback(err, objs);
                        } else {
                            that.adapter.log.warn('[getObjects] Invalid callback');
                        }
                    });
                }
            };

            that.commands.requireLog = function (socket, isEnabled, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'setObject', callback)) {
                    if (isEnabled) {
                        that.subscribe(socket, 'log', 'dummy');
                    } else {
                        that.unsubscribe(socket, 'log', 'dummy');
                    }

                    that.adapter.log.level === 'debug' && showSubscribes(socket, 'log');

                    typeof callback === 'function' && setImmediate(callback, null);
                }
            };

            that.commands.readLogs = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'readLogs', callback)) {
                    let result = {list: []};

                    // deliver file list
                    try {
                        const config = adapter.systemConfig;
                        // detect file log
                        if (config && config.log && config.log.transport) {
                            for (let transport in config.log.transport) {
                                if (config.log.transport.hasOwnProperty(transport) && config.log.transport[transport].type === 'file') {
                                    let filename = config.log.transport[transport].filename || 'log/';
                                    let parts = filename.replace(/\\/g, '/').split('/');
                                    parts.pop();
                                    filename = parts.join('/');
                                    if (filename[0] === '.') {
                                        filename = path.normalize(__dirname + '/../../../') + filename;
                                    }
                                    if (fs.existsSync(filename)) {
                                        let files = fs.readdirSync(filename);
                                        for (let f = 0; f < files.length; f++) {
                                            try {
                                                if (!fs.lstatSync(filename + '/' + files[f]).isDirectory()) {
                                                    result.list.push('log/' + transport + '/' + files[f]);
                                                }
                                            } catch (e) {
                                                // push unchecked
                                                // result.list.push('log/' + transport + '/' + files[f]);
                                                adapter.log.error('Cannot check file: ' + filename + '/' + files[f]);
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            result.error = 'no file loggers';
                            result.list = undefined;
                        }
                    } catch (e) {
                        adapter.log.error(e);
                        result.error = e;
                        result.list = undefined;
                    }
                    if (typeof callback === 'function') {
                        callback(result.error, result.list);
                    }
                }
            };
        } else {
            // only flot allowed
            that.commands.delObject = function (socket, id, callback) {
                if (id.match(/^flot\./)) {
                    if (updateSession(socket) && checkPermissions(socket, 'delObject', callback, id)) {
                        that.adapter.delForeignObject(id, {user: socket._acl.user}, callback);
                    }
                } else {
                    if (typeof callback === 'function') {
                        callback('permissionError');
                    }
                }
            };

            // inform user about problem
            that.commands.getAllObjects = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObjects', callback)) {
                    typeof callback === 'function' && callback('Admin is not enabled in cloud settings!');
                }
            };
        }

        that.commands.getState = function (socket, id, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getState', callback, id)) {
                that.adapter.getForeignState(id, {user: socket._acl.user}, callback);
            }
        };

        that.commands.setState = function (socket, id, state, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'setState', callback, id)) {
                if (typeof state !== 'object') state = {val: state};
                that.adapter.setForeignState(id, state, {user: socket._acl.user}, function (err, res) {
                    if (typeof callback === 'function') {
                        callback(err, res);
                    }
                });
            }
        };

        // allow admin access
        if (that.settings.allowAdmin) {
            that.commands.delState = function (socket, id, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'delState', callback, id)) {
                    that.adapter.delForeignState(id, {user: socket._acl.user}, callback);
                }
            };

            that.commands.addUser = function (socket, user, pass, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'addUser', callback, user)) {
                    addUser(user, pass, {user: socket._acl.user}, callback);
                }
            };

            that.commands.delUser = function (socket, user, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'delUser', callback, user)) {
                    delUser(user, {user: socket._acl.user}, callback);
                }
            };

            that.commands.addGroup = function (socket, group, desc, acl, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'addGroup', callback, group)) {
                    addGroup(group, desc, acl, {user: socket._acl.user}, callback);
                }
            };

            that.commands.delGroup = function (socket, group, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'delGroup', callback, group)) {
                    delGroup(group, {user: socket._acl.user}, callback);
                }
            };

            that.commands.changePassword = function (socket, user, pass, callback) {
                if (updateSession(socket)) {
                    if (user === socket._acl.user || checkPermissions(socket, 'changePassword', callback, user)) {
                        that.adapter.setPassword(user, pass, {user: socket._acl.user}, callback);
                    }
                }
            };
            // commands will be executed on host/controller
            // following response commands are expected: cmdStdout, cmdStderr, cmdExit
            that.commands.cmdExec = function (socket, host, id, cmd, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'cmdExec', callback, cmd)) {
                    that.adapter.log.debug(`cmdExec on ${host}(${id}): ${cmd}`);
                    that.adapter.sendToHost(host, 'cmdExec', {data: cmd, id: id});
                }
            };

            that.commands.eventsThreshold = function (socket, isActive) {
                if (!isActive) {
                    disableEventThreshold(true);
                } else {
                    enableEventThreshold();
                }
            };

            that.commands.getRatings = function (socket, update, callback) {
                if (updateSession(socket)) { // every one may read the rating
                    if (typeof callback === 'function') {
                        callback(null, {});
                    } else {
                        that.adapter.log.warn('[getRatings] Invalid callback')
                    }
                }
            };

            that.commands.decrypt = function (socket, encryptedText, callback) {
                if (that.secret) {
                    typeof callback === 'function' && callback(null, that.adapter.decrypt(that.secret, encryptedText));
                } else {
                    adapter.getForeignObject('system.config', (err, obj) => {
                        if (obj && obj.native && obj.native.secret) {
                            that.secret = obj.native.secret;
                            typeof callback === 'function' && callback(null, that.adapter.decrypt(that.secret, encryptedText));
                        } else {
                            adapter.log.error(`No system.config found: ${err}`);
                            typeof callback === 'function' && callback(err);
                        }
                    });
                }
            };

            that.commands.encrypt = function (socket, plainText, callback) {
                if (that.secret) {
                    typeof callback === 'function' && callback(null, that.adapter.encrypt(that.secret, plainText));
                } else {
                    adapter.getForeignObject('system.config', (err, obj) => {
                        if (obj && obj.native && obj.native.secret) {
                            that.secret = obj.native.secret;
                            typeof callback === 'function' && callback(null, that.adapter.encrypt(that.secret, plainText));
                        } else {
                            adapter.log.error(`No system.config found: ${err}`);
                            typeof callback === 'function' && callback(err);
                        }
                    });
                }
            };

            that.commands.getIsEasyModeStrict = function (socket, callback) {
                typeof callback === 'function' && callback(null, false);
            };

            that.commands.getEasyMode = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                    callback(null, {
                        strict: false,
                        configs: []
                    });
                    // TODO
                    /*let user;
                    if (settings.auth) {
                        user = socket._acl.user;
                        if (!user.startsWith('system.user.')) {
                            user = 'system.user.' + user;
                        }
                    } else {
                        user = adapter.config.defaultUser;
                    }

                    if (adapter.config.accessLimit) {
                        const configs = [];
                        const promises = [];
                        settings.accessAllowedConfigs.forEach(id => promises.push(readInstanceConfig(id, user, false, configs)));
                        settings.accessAllowedTabs.forEach(id    => promises.push(readInstanceConfig(id, user, true, configs)));

                        Promise.all(promises)
                            .then(() => {
                                callback(null, {
                                    strict: true,
                                    configs
                                });
                            });
                    } else {
                        adapter.getObjectView('system', 'instance', {startkey: 'system.adapter.', endkey: 'system.adapter.\u9999'}, {user}, (err, doc) => {
                            const promises = [];
                            const configs = [];
                            if (!err && doc.rows.length) {
                                for (let i = 0; i < doc.rows.length; i++) {
                                    const obj = doc.rows[i].value;
                                    if (obj.common.noConfig && !obj.common.adminTab) {
                                        continue;
                                    }
                                    if (!obj.common.enabled) {
                                        continue;
                                    }
                                    if (!obj.common.noConfig) {
                                        promises.push(readInstanceConfig(obj._id.substring('system.adapter.'.length), user, false, configs));
                                    }
                                }
                            }
                            Promise.all(promises)
                                .then(() =>
                                    callback(null, {
                                        strict: false,
                                        configs
                                    })
                                );
                        });
                    }*/
                }
            };

            that.commands.getAdapterInstances = function (socket, adapterName, callback) {
                if (typeof callback === 'function') {
                    if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                        that.adapter.getObjectView('system', 'instance',
                            {startkey: `system.adapter.${adapterName ? adapterName + '.' : ''}`, endkey: `system.adapter.${adapterName ? adapterName + '.' : ''}\u9999`},
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
                                            fixAdminUI(obj);
                                            return obj;
                                        })
                                        .filter(obj => obj && (!adapterName || (obj.common && obj.common.name === adapterName))));
                                }
                            });
                    }
                }
            };

            that.commands.getAdapters = function (socket, adapterName, callback) {
                if (typeof callback === 'function' && updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                    that.adapter.getObjectView('system', 'adapter',
                        {startkey: `system.adapter.${adapterName || ''}`, endkey: `system.adapter.${adapterName || '\u9999'}`},
                        (err, doc) =>
                        {
                            if (err) {
                                callback(err);
                            } else {
                                callback(null, doc.rows
                                    .filter(obj => obj && (!adapterName || (obj.common && obj.common.name === adapterName)))
                                    .map(item => {
                                        const obj = item.value;
                                        if (obj.common) {
                                            delete obj.common.news;
                                            delete obj.native;
                                        }
                                        fixAdminUI(obj);
                                        return obj;
                                    }));
                            }
                        });
                }
            };

            that.commands.getCompactInstances = function (socket, callback) {
                if (typeof callback === 'function') {
                    if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                        that.adapter.getObjectView('system', 'instance',
                            {startkey: `system.adapter.`, endkey: `system.adapter.\u9999`},
                            (err, doc) => {
                                if (err) {
                                    callback(err);
                                } else {
                                    // calculate
                                    const result = {};

                                    doc.rows.forEach(item => {
                                        const obj = item.value;
                                        result[item.id] = {
                                            adminTab: obj.common.adminTab,
                                            name: obj.common.name,
                                            icon: obj.common.icon,
                                            enabled: obj.common.enabled
                                        };
                                    });

                                    callback(null, result);
                                }
                            });
                    }
                }
            };

            that.commands.getCompactAdapters = function (socket, callback) {
                if (typeof callback === 'function') {
                    if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                        that.adapter.getObjectView('system', 'adapter',
                            {startkey: `system.adapter.`, endkey: `system.adapter.\u9999`},
                            (err, doc) => {
                                if (err) {
                                    callback(err);
                                } else {
                                    // calculate
                                    const result = {};

                                    doc.rows.forEach(item => {
                                        const obj = item.value;
                                        if (obj && obj.common && obj.common.name) {
                                            result[obj.common.name] = {icon: obj.common.icon, v: obj.common.version};
                                            if (obj.common.ignoreVersion) {
                                                result[obj.common.name].iv = obj.common.ignoreVersion;
                                            }
                                        }
                                    });

                                    callback(null, result);
                                }
                            });
                    }
                }
            };

            that.commands.getCompactInstalled = function (socket, host, callback) {
                if (typeof callback === 'function') {
                    if (updateSession(socket) && checkPermissions(socket, 'sendToHost', callback)) {
                        that.adapter.sendToHost(host, 'getInstalled', null, data => {
                            const result = {};
                            Object.keys(data).forEach(name => result[name] = {version: data[name].version});
                            callback(result);
                        });
                    }
                }
            };

            that.commands.getCompactSystemConfig = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                    that.adapter.getForeignObject('system.config', (err, obj) => {
                        obj = obj || {};
                        const secret = obj.native && obj.native.secret;
                        delete obj.native;
                        if (secret) {
                            obj.native = {secret};
                        }
                        callback(err,  obj);
                    });
                }
            };

            that.commands.getCompactRepository = function (socket, host, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'sendToHost', callback)) {
                    that.adapter.sendToHost(host, 'getRepository', {}, data => {
                        // Extract only version and icon
                        const result = {};
                        data && Object.keys(data).forEach(name => result[name] = {
                            version: data[name].version,
                            icon: data[name].icon
                        });
                        callback(result);
                    });
                }
            };

            that.commands.getCompactHosts = function (socket, callback) {
                if (updateSession(socket) && checkPermissions(socket, 'getObject', callback)) {
                    that.adapter.getObjectView('system', 'host',
                        {startkey: 'system.host.', endkey: 'system.host.\u9999'}, (err, doc) => {
                            if (err) {
                                callback(err);
                            } else {
                                const result = [];
                                doc.rows.map(item => {
                                    const host = item.value;
                                    if (host) {
                                        host.common = host.common || {};
                                        result.push({
                                            _id: host._id,
                                            common: {
                                                name: host.common.name,
                                                icon: host.common.icon,
                                                color: host.common.color,
                                                installedVersion: host.common.installedVersion
                                            },
                                            native: {
                                                hardware: {
                                                    networkInterfaces: (host.native && host.native.hardware && host.native.hardware.networkInterfaces) || undefined
                                                }
                                            }
                                        });
                                    }
                                })
                                callback(null, result);
                            }
                        });
                }
            };
        }

        that.commands.getAdapterName = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getVersion', callback)) {
                if (typeof callback === 'function') {
                    callback(null, that.adapter.name);
                } else {
                    that.adapter.log.warn('[getAdapterName] Invalid callback')
                }
            }
        };

        that.commands.getCurrentInstance = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getVersion', callback)) {
                if (typeof callback === 'function') {
                    callback(null, that.adapter.namespace);
                } else {
                    that.adapter.log.warn('[getCurrentInstance] Invalid callback')
                }
            }
        };

        that.commands.checkFeatureSupported = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getVersion', callback)) {
                if (typeof callback === 'function') {
                    callback(null, false);
                } else {
                    that.adapter.log.warn('[checkFeatureSupported] Invalid callback')
                }
            }
        };

        that.commands.getVersion = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getVersion', callback)) {
                if (typeof callback === 'function') {
                    callback(that.adapter.version);
                } else {
                    that.adapter.log.warn('[getVersion] Invalid callback')
                }
            }
        };

        that.commands.subscribe = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'subscribe', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.subscribe(socket, 'stateChange', pattern[p]);
                    }
                } else {
                    that.subscribe(socket, 'stateChange', pattern);
                }

                that.adapter.log.level === 'debug' && showSubscribes(socket, 'stateChange');

                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        // same as subscribe
        that.commands.subscribeStates = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'subscribe', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.subscribe(socket, 'stateChange', pattern[p]);
                    }
                } else {
                    that.subscribe(socket, 'stateChange', pattern);
                }

                that.adapter.log.level === 'debug' && showSubscribes(socket, 'stateChange');

                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        that.commands.unsubscribe = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unsubscribe', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.unsubscribe(socket, 'stateChange', pattern[p]);
                    }
                } else {
                    that.unsubscribe(socket, 'stateChange', pattern);
                }

                that.adapter.log.level === 'debug' && showSubscribes(socket, 'stateChange');

                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        // same as unsubscribe
        that.commands.unsubscribeStates = function (socket, pattern, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unsubscribe', callback, pattern)) {
                if (pattern && typeof pattern === 'object' && pattern instanceof Array) {
                    for (let p = 0; p < pattern.length; p++) {
                        that.unsubscribe(socket, 'stateChange', pattern[p]);
                    }
                } else {
                    that.unsubscribe(socket, 'stateChange', pattern);
                }

                that.adapter.log.level === 'debug' && showSubscribes(socket, 'stateChange');

                typeof callback === 'function' && setImmediate(callback, null);
            }
        };

        // new History
        that.commands.getHistory = function (socket, id, options, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getStateHistory', callback, id)) {
                that.adapter.getHistory(id, options, function (err, data, step, sessionId) {
                    if (typeof callback === 'function') {
                        callback(err, data, step, sessionId);
                    } else {
                        that.adapter.log.warn('[getHistory] Invalid callback')
                    }
                });
            }
        };

        // HTTP
        that.commands.httpGet = function (socket, url, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'httpGet', callback, url)) {
                request = request || require('request');
                that.adapter.log.debug('httpGet: ' + url);
                request(url, callback);
            }
        };

        // commands
        that.commands.sendTo = function (socket, adapterInstance, command, message, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'sendTo', callback, command)) {
                that.adapter.sendTo(adapterInstance, command, message, callback);
            }
        };

        // following commands are protected and require the extra permissions
        const protectedCommands = ['cmdExec', 'getLocationOnDisk', 'getDiagData', 'getDevList', 'delLogs', 'writeDirAsZip', 'writeObjectsAsZip', 'readObjectsAsZip', 'checkLogging', 'updateMultihost'];

        that.commands.sendToHost = function (socket, host, command, message, callback) {
            // host can answer following commands: cmdExec, getRepository, getInstalled, getInstalledAdapter, getVersion, getDiagData, getLocationOnDisk, getDevList, getLogs, getHostInfo,
            // delLogs, readDirAsZip, writeDirAsZip, readObjectsAsZip, writeObjectsAsZip, checkLogging, updateMultihost
            if (updateSession(socket) && checkPermissions(socket, protectedCommands.includes(command) ? 'cmdExec' : 'sendToHost', callback, command)) {
                that.adapter.sendToHost(host, command, message, callback);
            }
        };

        that.commands.authEnabled = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'authEnabled', callback)) {
                // that.settings.auth ??
                if (typeof callback === 'function') {
                    callback(that.adapter.config.auth, socket._acl.user.replace(/^system\.user\./, ''));
                } else {
                    that.adapter.log.warn('[authEnabled] Invalid callback')
                }
            }
        };

        // file operations
        that.commands.readFile = function (socket, _adapter, fileName, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'readFile', callback, fileName)) {
                that.adapter.readFile(_adapter, fileName, {user: socket._acl.user}, callback);
            }
        };

        that.commands.readFile64 = function (socket, _adapter, fileName, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'readFile64', callback, fileName)) {
                that.adapter.readFile(_adapter, fileName, {user: socket._acl.user}, function (err, buffer, type) {
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
                        that.adapter.log.warn('[readFile64] Invalid callback')
                    }
                });
            }
        };

        that.commands.writeFile64 = function (socket, _adapter, fileName, data64, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {user: socket._acl.user};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (updateSession(socket) && checkPermissions(socket, 'writeFile64', callback, fileName)) {
                //Convert base 64 to buffer
                const buffer = Buffer.from(data64, 'base64');
                that.adapter.writeFile(_adapter, fileName, buffer, options, callback);
            }
        };

        that.commands.writeFile = function (socket, _adapter, fileName, data, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {user: socket._acl.user};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (updateSession(socket) && checkPermissions(socket, 'writeFile', callback, fileName)) {
                that.adapter.writeFile(_adapter, fileName, data, options, callback);
            }
        };

        that.commands.unlink = function (socket, _adapter, name, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unlink', callback, name)) {
                that.adapter.unlink(_adapter, name, {user: socket._acl.user}, callback);
            }
        };

        that.commands.deleteFile = function (socket, _adapter, name, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unlink', callback, name)) {
                that.adapter.unlink(_adapter, name, {user: socket._acl.user}, callback);
            }
        };

        that.commands.deleteFolder = function (socket, _adapter, name, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'unlink', callback, name)) {
                that.adapter.unlink(_adapter, name, {user: socket._acl.user}, callback);
            }
        };

        that.commands.rename = function (socket, _adapter, oldName, newName, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'rename', callback, oldName)) {
                that.adapter.rename(_adapter, oldName, newName, {user: socket._acl.user}, callback);
            }
        };

        that.commands.mkdir = function (socket, _adapter, dirName, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'mkdir', callback, dirName)) {
                that.adapter.mkdir(_adapter, dirName, {user: socket._acl.user}, callback);
            }
        };

        that.commands.readDir = function (socket, _adapter, dirName, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (options.filter === undefined) {
                options.filter = true;
            }

            if (updateSession(socket) && checkPermissions(socket, 'readDir', callback, dirName)) {
                that.adapter.readDir(_adapter, dirName, options, callback);
            }
        };

        that.commands.chmodFile = function (socket, _adapter, dirName, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (options.filter === undefined) {
                options.filter = true;
            }

            if (updateSession(socket) && checkPermissions(socket, 'chmodFile', callback, dirName)) {
                that.adapter.chmodFile(_adapter, dirName, options, callback);
            }
        };

        that.commands.chownFile = function (socket, _adapter, dirName, options, callback) {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            options = options || {};
            options.user = socket._acl.user;

            if (options.filter === undefined) {
                options.filter = true;
            }

            if (updateSession(socket) && checkPermissions(socket, 'chmodFile', callback, dirName)) {
                that.adapter.chownFile(_adapter, dirName, options, callback);
            }
        };

        that.commands.fileExists = function (socket, _adapter, filename, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'readFile', callback, filename)) {
                that.adapter.fileExists(_adapter, filename, {user: socket._acl.user}, callback);
            }
        };

        that.commands.logout = function (socket, callback) {
            that.adapter.destroySession(socket._sessionID, callback);
        };

        that.commands.listPermissions = function (socket, callback) {
            if (updateSession(socket)) {
                if (typeof callback === 'function') {
                    callback(commandsPermissions);
                } else {
                    that.adapter.log.warn('[listPermissions] Invalid callback');
                }
            }
        };

        that.commands.getUserPermissions = function (socket, callback) {
            if (updateSession(socket) && checkPermissions(socket, 'getUserPermissions', callback)) {
                if (typeof callback === 'function') {
                    callback(null, socket._acl);
                } else {
                    that.adapter.log.warn('[getUserPermissions] Invalid callback')
                }
            }
        };

        // if client mode
        if (CLIENT_MODE) {
            that.commands.cloudDisconnect = function (socket, socketId, err) {
                // error could be a time. Detect if it is on the first place (old cloud)
                if (socketId && !isNaN(parseInt(socketId.toString().substring(0, 4), 10))) {
                    err = socketId;
                    socketId = 0;
                }

                err && that.adapter.log.warn(`User disconnected from cloud: ${socketId} ${err}`);

                if (socket && socket.___socket) {
                    socket = socket.___socket;
                }

                if (socket._subSockets && socketId) {
                    if (socket._subSockets[socketId]) {
                        unsubscribeSocket(socket._subSockets[socketId], 'stateChange');
                        unsubscribeSocket(socket._subSockets[socketId], 'objectChange');
                        unsubscribeSocket(socket._subSockets[socketId], 'log');
                        if (socket._subSockets[socketId]) {
                            delete socket._subSockets[socketId];
                        }
                    } else {
                        that.adapter.log.warn('Received disconnection for non-existing socketId: ' + socketId)
                    }
                } else {
                    unsubscribeSocket(socket, 'stateChange');
                    unsubscribeSocket(socket, 'objectChange');
                    unsubscribeSocket(socket, 'log');

                    // unsubscribe all sub-sockets, because client does not use mutli-client
                    if (socket._subSockets) {
                        Object.keys(socket._subSockets)
                            .forEach(socketId => {
                                unsubscribeSocket(socket._subSockets[socketId], 'stateChange');
                                unsubscribeSocket(socket._subSockets[socketId], 'objectChange');
                                unsubscribeSocket(socket._subSockets[socketId], 'log');
                                if (socket._subSockets[socketId]) {
                                    delete socket._subSockets[socketId];
                                }
                            });
                        delete socket._subSockets;
                    }
                }

                that.emit('cloudDisconnect', socketId, socket._name);
            };

            that.commands.cloudVersion = function (socket, apiVersion) {
                if (socket && socket.___socket) {
                    socket = socket.___socket;
                }
                that.adapter.log.debug('Cloud version: ' + apiVersion);
                if (socket) {
                    socket.__apiVersion = apiVersion;
                }
            };

            that.commands.cloudConnect = function (socket, socketId) {
                if (!socket.___socket) {
                    socket._subSockets = socket._subSockets || {};
                    socket._subSockets[socketId] = socket._subSockets[socketId] || {
                        id: socketId,
                        ___socket: socket,
                        _acl: socket._acl
                    }
                }
                // do not auto-subscribe. The client must resubscribe all states anew
                // subscribeSocket(socket, 'stateChange');
                // subscribeSocket(socket, 'objectChange');
                // subscribeSocket(socket, 'log');
                that.emit('cloudConnect', socketId);
            };

            that.commands.cloudCommand = function (socket, cmd, data) {
                if (cmd === 'stop') {
                    stopAdapter(data);
                } else if (cmd === 'redirect') {
                    redirectAdapter(data);
                } else if (cmd === 'wait') {
                    waitForConnect(data);
                } else if (cmd === 'log') {
                    adapter.log.warn(data);
                } else {
                    that.adapter.log.warn(`Received unknown command "${cmd}" from server`);
                }
            };

            that.commands.log = function (socket, level, text) {
                if (level === 'error' || level === 'warn' || level === 'debug' || level === 'info') {
                    adapter.log[level](text);
                } else {
                    adapter.log.warn(`[${level}] ${text}`);
                }
            }
        }
    }

    function sendToLovelace(ioSocket, remoteSocketId, dataStr) {
        let llSocket = that.lovelaceSockets[remoteSocketId];
        if (llSocket && llSocket.connected) {
            adapter.log.debug(`[Lovelace|${remoteSocketId}] send: ${dataStr}`);
            dataStr && llSocket.socket.send(dataStr);
        } else if (!llSocket){
            adapter.log.debug(`[Lovelace|${remoteSocketId}] establish connection`);
            that.lovelaceSockets[remoteSocketId] = llSocket = {socket: null, connected: false, messages: dataStr ? [dataStr] : []};
            llSocket.socket = new WebSocket(settings.lovelaceServer.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/api/websocket');

            llSocket.socket.on('open', () => {
                llSocket.connected = true;
                adapter.log.debug(`[Lovelace|${remoteSocketId}] connected`);
                llSocket.messages && llSocket.messages.forEach(message =>
                    llSocket.socket.send(dataStr));
                llSocket.messages = null;
            });

            llSocket.socket.on('close', () => {
                llSocket.connected = false;
                delete that.lovelaceSockets[remoteSocketId];
                adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected`);
            });

            llSocket.socket.on('message', (data, isBinary) => {
                const message = isBinary ? data : data.toString();
                llSocket.connected = true;
                adapter.log.debug(`[Lovelace|${remoteSocketId}] received ${message}`);
                ioSocket.emit('ll', remoteSocketId, message);
            });
            llSocket.socket.on('error', error => {
                llSocket.connected = true;
                delete that.lovelaceSockets[remoteSocketId];
                adapter.log.debug(`[Lovelace|${remoteSocketId}] local is disconnected: ` + error);
            });
        } else {
            adapter.log.debug(`[Lovelace|${remoteSocketId}] store message: ${dataStr}`)
            llSocket.messages.push(dataStr);
        }
    }

    function socketEvents(socket, address) {
        if (socket.conn) {
            that.adapter.log.info(`Connected ${socket._acl.user} from ${address}`);
        } else {
            that.adapter.log.info(`Trying to connect as ${socket._acl.user}${address ? ' from ' + address : ''}`);
        }

        if (!that.infoTimeout) {
            that.infoTimeout = setTimeout(updateConnectedInfo, 1000);
        }

        if (typeof that.settings.extensions === 'function') {
            that.settings.extensions(socket);
        }

        socket.on('error', err =>
            that.adapter.log.error(`Socket error: ${err}`));

        // connect/disconnect
        socket.on('disconnect', function (error) { // let function here because of this
            unsubscribeSocket(this, 'stateChange');
            unsubscribeSocket(this, 'objectChange');
            unsubscribeSocket(this, 'log');
            if (!that.infoTimeout) {
                that.infoTimeout = setTimeout(updateConnectedInfo, 1000);
            }

            // if client mode
            if (!socket.conn) {
                socket._apiKeyOk = false;
                that.emit && that.emit('disconnect', error);
            }
        });

        // if client mode
        if (!socket.conn) {
            socket._apiKeyOk = false;

            // cloud multi client command
            socket.on('mc', function (socketId, command) {
                // Arguments: socket.id, command, arg1..argN, cb
                if (that.commands[command]) {
                    // Create sub-socket if not exists
                    socket._subSockets = socket._subSockets || {};
                    if (!socket._subSockets[socketId]) {
                        socket._subSockets[socketId] = {
                            id: socketId,
                            ___socket: socket,
                            _acl: socket._acl
                        };
                    }

                    switch (arguments.length) {
                        case 0:
                            adapter.log.error('Received invalid command (no socketID found)');
                            break;
                        case 1:
                            adapter.log.error(`Received invalid command (no command found): ${socketId}`);
                            break;
                        case 2:
                            that.commands[command](socket._subSockets[socketId], arguments[2]);
                            break;
                        case 3:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3]);
                            break;
                        case 4:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4]);
                            break;
                        case 5:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4], arguments[5]);
                            break;
                        case 6:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
                            break;
                        case 7:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7]);
                            break;
                        case 8:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7], arguments[8]);
                            break;
                        default:
                            that.commands[command](socket._subSockets[socketId], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7], arguments[8], arguments[9]);
                            break;
                    }
                } else if (command === 'll') { // lovelace
                    const remoteSocketId = arguments[0];
                    if (!settings.lovelaceServer) {
                        adapter.log.info(`[Lovelace|${remoteSocketId}] received lovelace command, but lovelase is not enabled in config`);
                    } else {
                        try {
                            const data = JSON.parse(arguments[2]);

                            if (data.type === 'connection') {
                                sendToLovelace(socket, remoteSocketId);
                            } else if (data.type === 'close') {
                                adapter.log.info(`[Lovelace|${remoteSocketId}] remote client disconnected`);
                                that.lovelaceSockets[remoteSocketId] && that.lovelaceSockets[remoteSocketId].socket.close();
                                delete that.lovelaceSockets[remoteSocketId];
                            } else if (data.type === 'error') {
                                adapter.log.error(`[Lovelace|${remoteSocketId}] remote client: ${data.error}`);
                            } else {
                                sendToLovelace(socket, remoteSocketId, arguments[2]);
                            }
                        } catch (e) {
                            adapter.log.error(`[Lovelace|${remoteSocketId}] Cannot parse: ${arguments[2]}`);
                        }
                    }

                } else {
                    adapter.log.error(`Received unknown command 1: ${command}`);

                    let func = null;
                    for (let a = arguments.length - 1; a >= 0; a--) {
                        if (typeof arguments[a] === 'function') {
                            func = arguments[a];
                            break;
                        }
                    }

                    func && func('unknown command');
                }
            });

            // only active in client mode
            socket.on('connect', () => {
                socket._subSockets = {};
                that.adapter.log.debug('Connected. Check api key...');
                socket._apiKeyOk = false;

                // 2018_01_20 workaround for pro: Remove it after next pro maintenance
                if (that.settings.apikey.startsWith('@pro_')) {
                    socket._apiKeyOk = true;
                    that.emit && that.emit('connect');
                }

                // send api key if exists
                socket.emit('apikey', that.settings.apikey, that.settings.version, that.settings.uuid, (err, instructions) => {
                    // instructions = {
                    //     validTill: '2018-03-14T01:01:01.567Z',
                    //     command: 'wait' | 'stop' | 'redirect'
                    //     delaySeconds: seconds for wait
                    //     reason: Description of command
                    //     url: redirect URL
                    //     notSave: true | false for url. Save it or just use it

                    if (instructions) {
                        if (typeof instructions !== 'object') {
                            that.adapter.setState('info.remoteTill', new Date(instructions).toISOString(), true);
                        } else {
                            if (instructions.validTill) {
                                that.adapter.setState('info.remoteTill', new Date(instructions.validTill).toISOString(), true);
                            }
                            if (instructions.command === 'stop') {
                                stopAdapter(instructions);
                                return;
                            } else if (instructions.command === 'redirect') {
                                redirectAdapter(instructions);
                                return;
                            } else if (instructions.command === 'wait') {
                                waitForConnect(instructions);
                                return;
                            }
                        }
                    }

                    if (!err) {
                        that.adapter.log.debug('API KEY OK');
                        socket._apiKeyOk = true;

                        that.emit && that.emit('connect');
                    } else {
                        if (err.includes('Please buy remote access to use pro.')) {
                            stopAdapter('Please buy remote access to use pro.');
                        }
                        that.adapter.log.error(err);
                        socket.close(); // disconnect
                    }
                });

                if (socket._sessionID) {
                    that.adapter.getSession(socket._sessionID, obj => {
                        if (obj && obj.passport) {
                            socket._acl.user = obj.passport.user;
                        } else {
                            socket._acl.user = '';
                            socket.emit('reauthenticate');
                            socket.disconnect();
                        }

                        if (socket._authPending) {
                            socket._authPending(!!socket._acl.user, true);
                            delete socket._authPending;
                        }
                    });
                }

                // actually this is useless, because socket._subscribe not yet exists, BF: 2019_11_14
                subscribeSocket(socket, 'stateChange');
                subscribeSocket(socket, 'objectChange');
                subscribeSocket(socket, 'log');
            });

            /*socket.on('reconnect', function (attempt) {
                that.adapter.log.debug('Connected after attempt ' + attempt);
            });
            socket.on('reconnect_attempt', function (attempt) {
                that.adapter.log.debug('reconnect_attempt');
            });
            socket.on('connect_error', function (error) {
                that.adapter.log.debug('connect_error: ' + error);
            });
            socket.on('connect_timeout', function (error) {
                that.adapter.log.debug('connect_timeout');
            });
            socket.on('reconnect_failed', function (error) {
                that.adapter.log.debug('reconnect_failed');
            });*/
        } else {
            // if server mode
            if (socket.conn.request.sessionID) {
                socket._secure    = true;
                socket._sessionID = socket.conn.request.sessionID;
                // Get user for session
                that.settings.store.get(socket.conn.request.sessionID, (err, obj) => {
                    if (!obj || !obj.passport) {
                        socket._acl.user = '';
                        socket.emit('reauthenticate');
                        socket.disconnect();
                    }
                    if (socket._authPending) {
                        socket._authPending(!!socket._acl.user, true);
                        delete socket._authPending;
                    }
                });
            }

            subscribeSocket(socket, 'stateChange');
            subscribeSocket(socket, 'objectChange');
            subscribeSocket(socket, 'log');
        }

        // register all commands for old cloud
        // new cloud sends all commands only via "mc" command with socket context
        Object.keys(that.commands)
            .forEach(command => socket.on(command, function () {
                // console.log('RECEIVED COMMAND: ' + command);
                switch (arguments.length) {
                    case 0:
                        that.commands[command](socket);
                        break;
                    case 1:
                        that.commands[command](socket, arguments[0]);
                        break;
                    case 2:
                        that.commands[command](socket, arguments[0], arguments[1]);
                        break;
                    case 3:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2]);
                        break;
                    case 4:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2], arguments[3]);
                        break;
                    case 5:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
                        break;
                    case 6:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]);
                        break;
                    case 7:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
                        break;
                    default:
                        that.commands[command](socket, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7]);
                        break;
                }
            }));

    }

    function updateConnectedInfo() {
        if (that.infoTimeout) {
            clearTimeout(that.infoTimeout);
            that.infoTimeout = null;
        }
        if (that.server && that.server.sockets) {
            let text = '';
            let cnt = 0;
            const clients = that.server.sockets.connected;

            for (let i in clients) {
                if (clients.hasOwnProperty(i)) {
                    text += (text ? ', ' : '') + (clients[i]._name || 'noname');
                    cnt++;
                }
            }
            text = `[${cnt}]${text}`;
            that.adapter.setState('connected', text, true);
        }
    }

    /*
    this.publishAll = function (type, id, obj) {
        if (id === undefined) {
            console.log('Problem');
        }

        const clients = this.server.sockets.connected;

        for (let i in clients) {
            if (clients.hasOwnProperty(i)) {
                publish(clients[i], type, id, obj);
            }
        }
    };

    this.sendLog = function (obj) {
        // TODO Build in some threshold
        if (this.server && this.server.sockets) {
            this.server.sockets.emit('log', obj);
        }
    };
    */

    (function __constructor() {
        // create all commands
        initCommands();

        if (that.settings.allowAdmin) {
            // detect event bursts
            setInterval(function () {
                if (!eventsThreshold.active) {
                    if (eventsThreshold.count > eventsThreshold.value) {
                        eventsThreshold.accidents++;

                        if (eventsThreshold.accidents >= eventsThreshold.repeatSeconds) {
                            enableEventThreshold();
                        }
                    } else {
                        eventsThreshold.accidents = 0;
                    }
                    eventsThreshold.count = 0;
                } else if (Date.now() - eventsThreshold.timeActivated > 60000) {
                    disableEventThreshold();
                }
            }, eventsThreshold.checkInterval);
        }

        // it can be used as client too for cloud
        if (!CLIENT_MODE) {
            if (!that.webServer.__inited) {
                that.server = require('socket.io').listen(that.webServer);
                that.webServer.__inited = true;
            }

            // force using only websockets
            that.settings.forceWebSockets && that.server.set('transports', ['websocket']);
        } else {
            that.server = server;
        }

        //    socket = socketio.listen(settings.port, (settings.bind && settings.bind !== "0.0.0.0") ? settings.bind : undefined);
        that.adapter.config.defaultUser = that.adapter.config.defaultUser || 'system.user.admin';
        if (!that.adapter.config.defaultUser.match(/^system\.user\./)) {
            that.adapter.config.defaultUser = 'system.user.' + that.adapter.config.defaultUser;
        }

        if (that.settings.auth && that.server) {
            that.server.use((socket, next) => {
                if (!socket.request._query.user || !socket.request._query.pass) {
                    that.adapter.log.warn('No password or username!');
                    next(new Error('Authentication error'));
                } else {
                    that.adapter.checkPassword(socket.request._query.user, socket.request._query.pass, function (res) {
                        if (res) {
                            that.adapter.log.debug(`Logged in: ${socket.request._query.user}, ${socket.request._query.pass}`);
                            next();
                        } else {
                            that.adapter.log.warn(`Invalid password or user name: ${socket.request._query.user}, ${socket.request._query.pass}`);
                            socket.emit('reauthenticate');
                            next(new Error('Invalid password or user name'));
                        }
                    });
                }
            });
        }

        // Enable cross domain access
        if (that.settings.crossDomain && that.server && that.server.set) {
            that.server.set('origins', '*:*');
        }

        that.settings.ttl = that.settings.ttl || 3600;

        that.server && that.server.on('connection', that.initSocket);

        if (settings.port) {
            that.adapter.log.info(`${settings.secure ? 'Secure ' : ''}socket.io server listening on port ${settings.port}`);
        }

        if (!that.infoTimeout) {
            that.infoTimeout = setTimeout(updateConnectedInfo, 1000);
        }

        // if client mode => add event handlers
        if (CLIENT_MODE && that.server) {
            that.initSocket(that.server);
        }
    })();
}

util.inherits(IOSocket, EventEmitter);

module.exports = IOSocket;
