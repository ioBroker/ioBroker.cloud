'use strict';
/**
 * Unit tests for the adapter side of the cloud SSH tunnel. They drive the compiled lib directly with a
 * fake "cloud" (an emit collector) and a real local TCP echo server, so the allow-list, the two-way
 * piping and the close/error paths are covered without a running cloud or js-controller.
 *
 * Needs a build first: `npm run build` (or `tsc -p tsconfig.build.json`).
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const { CloudSshTunnel } = require('../build/lib/sshTunnel');

const silentLog = { debug() {}, warn() {}, error() {} };

/** Collects every event the tunnel emits back to the "cloud", newest calls appended. */
function collector() {
    const events = [];
    const emit = (event, ...args) => events.push({ event, args });
    return {
        emit,
        events,
        of: name => events.filter(e => e.event === name),
        last: name => [...events].reverse().find(e => e.event === name),
    };
}

/**
 * @param condition checked every 5 ms
 * @param ms how long to wait at most
 */
function waitFor(condition, ms) {
    return new Promise(resolve => {
        const until = Date.now() + ms;
        const tick = () => {
            if (condition() || Date.now() > until) {
                resolve(condition());
            } else {
                setTimeout(tick, 5);
            }
        };
        tick();
    });
}

describe('CloudSshTunnel allow-list', () => {
    function make(opts) {
        const c = collector();
        const tunnel = new CloudSshTunnel({ emit: c.emit, log: silentLog, ...opts });
        return { tunnel, c };
    }

    it('refuses every tunnel while disabled', () => {
        const { tunnel, c } = make({ enabled: false, rules: [{ host: '127.0.0.1', ports: '' }] });
        tunnel.open('id1', '127.0.0.1', 22);
        assert.equal(tunnel.count, 0);
        assert.match(c.last('sshError').args[1], /disabled/);
    });

    it('refuses a host that no rule matches', () => {
        const { tunnel, c } = make({ enabled: true, rules: [{ host: '127.0.0.1', ports: '' }] });
        tunnel.open('id1', '10.0.0.5', 22);
        assert.equal(tunnel.count, 0);
        assert.match(c.last('sshError').args[1], /not allowed/);
    });

    it('refuses a port that its rule does not allow', () => {
        const { tunnel, c } = make({ enabled: true, rules: [{ host: '*', ports: '22' }] });
        tunnel.open('id1', '127.0.0.1', 9000);
        assert.equal(tunnel.count, 0);
        assert.match(c.last('sshError').args[1], /not allowed/);
    });

    it('refuses everything when there are no rules', () => {
        const { tunnel } = make({ enabled: true, rules: [] });
        tunnel.open('id1', '127.0.0.1', 22);
        assert.equal(tunnel.count, 0);
    });

    it('applies ports per host: one host limited, another wide open', () => {
        const rules = [
            { host: '127.0.0.1', ports: '22' },
            { host: '192.168.1.0/24', ports: '' },
        ];
        const { tunnel } = make({ enabled: true, rules });
        assert.equal(tunnel.isAllowed('127.0.0.1', 22), true);
        assert.equal(tunnel.isAllowed('127.0.0.1', 8081), false, 'localhost is limited to 22');
        assert.equal(tunnel.isAllowed('192.168.1.50', 8081), true, 'the subnet allows any port');
        assert.equal(tunnel.isAllowed('192.168.2.50', 8081), false, 'outside the subnet is refused');
    });

    it('matches exact, wildcard, CIDR and range hosts', () => {
        assert.equal(CloudSshTunnel.hostMatches('localhost', 'localhost'), true);
        assert.equal(CloudSshTunnel.hostMatches('192.168.*', '192.168.5.9'), true);
        assert.equal(CloudSshTunnel.hostMatches('192.168.*', '10.0.0.1'), false);
        assert.equal(CloudSshTunnel.hostMatches('192.168.1.0/24', '192.168.1.200'), true);
        assert.equal(CloudSshTunnel.hostMatches('192.168.1.0/24', '192.168.2.1'), false);
        assert.equal(CloudSshTunnel.hostMatches('10.0.0.10-10.0.0.20', '10.0.0.15'), true);
        assert.equal(CloudSshTunnel.hostMatches('10.0.0.10-10.0.0.20', '10.0.0.21'), false);
    });

    it('matches ports as list, range and any', () => {
        assert.equal(CloudSshTunnel.portMatches('', 12345), true, 'empty = any');
        assert.equal(CloudSshTunnel.portMatches('*', 12345), true);
        assert.equal(CloudSshTunnel.portMatches('all', 12345), true);
        assert.equal(CloudSshTunnel.portMatches('22, 8081', 8081), true);
        assert.equal(CloudSshTunnel.portMatches('22, 8081', 8082), false);
        assert.equal(CloudSshTunnel.portMatches('8000-8100', 8050), true);
        assert.equal(CloudSshTunnel.portMatches('8000-8100', 8101), false);
    });

    it('rejects malformed IPs in ipToLong', () => {
        assert.equal(CloudSshTunnel.ipToLong('1.2.3.4'), (1 << 24) + (2 << 16) + (3 << 8) + 4);
        assert.equal(CloudSshTunnel.ipToLong('999.1.1.1'), null);
        assert.equal(CloudSshTunnel.ipToLong('localhost'), null);
        assert.equal(CloudSshTunnel.ipToLong('1.2.3'), null);
    });
});

describe('CloudSshTunnel piping', () => {
    let echo;
    let port;

    before(done => {
        // A TCP echo server standing in for the local sshd / gateway.
        echo = net.createServer(socket => socket.pipe(socket));
        echo.listen(0, '127.0.0.1', () => {
            port = echo.address().port;
            done();
        });
    });

    after(done => echo.close(done));

    it('connects, reports ready, and echoes bytes back to the cloud', async () => {
        const c = collector();
        const tunnel = new CloudSshTunnel({
            emit: c.emit,
            log: silentLog,
            enabled: true,
            rules: [{ host: '127.0.0.1', ports: '' }],
        });

        tunnel.open('id1', '127.0.0.1', port);
        assert.equal(await waitFor(() => c.of('sshReady').length === 1, 2000), true, 'sshReady arrives');

        tunnel.write('id1', Buffer.from('hello').toString('base64'));
        assert.equal(await waitFor(() => c.of('sshData').length >= 1, 2000), true, 'sshData arrives');
        const back = Buffer.from(c.of('sshData')[0].args[1], 'base64').toString();
        assert.equal(back, 'hello');

        tunnel.destroy();
    });

    it('reports sshError for a refused connection', async () => {
        const c = collector();
        const tunnel = new CloudSshTunnel({
            emit: c.emit,
            log: silentLog,
            enabled: true,
            rules: [{ host: '127.0.0.1', ports: '' }],
        });

        // Nothing listens on this port -> connect fails -> sshError.
        tunnel.open('id1', '127.0.0.1', 9);
        assert.equal(await waitFor(() => c.of('sshError').length >= 1, 3000), true, 'sshError arrives');
    });

    it('does not echo sshClose back when the cloud closed the tunnel', async () => {
        const c = collector();
        const tunnel = new CloudSshTunnel({
            emit: c.emit,
            log: silentLog,
            enabled: true,
            rules: [{ host: '127.0.0.1', ports: '' }],
        });

        tunnel.open('id1', '127.0.0.1', port);
        assert.equal(await waitFor(() => c.of('sshReady').length === 1, 2000), true);

        tunnel.close('id1');
        // Give the socket 'close' event a chance to fire; it must NOT produce an sshClose back.
        await waitFor(() => false, 100);
        assert.equal(c.of('sshClose').length, 0);
        assert.equal(tunnel.count, 0);
    });
});
