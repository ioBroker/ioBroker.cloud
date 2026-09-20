/**
 * Adapter side of the cloud SSH tunnel (variant A - the cloud is only a jump host).
 *
 * The cloud server authenticates the user and forwards the raw bytes of a `direct-tcpip` channel to this
 * adapter over the existing socket.io connection. This class is the other half: it opens a plain TCP
 * socket to the requested `host:port` on the local machine and pipes the bytes both ways. The inner SSH
 * handshake happens end-to-end between the user's client and the local sshd, so nothing here can read it.
 *
 * The allow-list is the authoritative one - only this machine can decide what it exposes. It is a list of
 * rules, each pairing a host matcher with a port matcher, so a single IP may allow just one port while a
 * whole subnet allows all of them. Nothing is opened until the feature is on and a rule matches.
 *
 * Host matchers: an exact IP or hostname (`localhost`), a `*` wildcard (`192.168.*`), a CIDR
 * (`192.168.1.0/24`), or a range (`192.168.1.10-192.168.1.50`).
 * Port matchers: a comma separated list of ports and ranges (`22, 8000-8100`), or empty / `*` / `all`.
 *
 * Events, all payloads base64. Server -> adapter: `sshOpen(id,host,port)`, `sshData(id,base64)`,
 * `sshClose(id)`. Adapter -> server: `sshReady(id)`, `sshData(id,base64)`, `sshClose(id)`,
 * `sshError(id,message)`.
 */
import { connect, type Socket as NetSocket } from 'node:net';

/** One allow-list entry: which host(s) and which port(s) on them may be reached. */
export interface SshRule {
    /** Exact IP/hostname, `*` wildcard, CIDR (`192.168.1.0/24`), or range (`192.168.1.10-192.168.1.50`). */
    host: string;
    /** Ports and ranges, comma separated (`22, 8000-8100`). Empty, `*` or `all` mean any port. */
    ports: string;
}

export interface CloudSshTunnelOptions {
    /** Send an event back to the cloud (usually `this.socket.emit`). */
    emit: (event: string, ...args: any[]) => void;
    log: { debug: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
    /** Master switch. When off, every `sshOpen` is refused. */
    enabled: boolean;
    /** The allow-list. Empty means nothing is allowed. */
    rules: SshRule[];
    /** Most tunnels open at once, as a safety cap. Default 20. */
    maxTunnels?: number;
}

const DEFAULT_MAX_TUNNELS = 20;

export class CloudSshTunnel {
    private readonly sockets = new Map<string, NetSocket>();
    private readonly emit: (event: string, ...args: any[]) => void;
    private readonly log: CloudSshTunnelOptions['log'];
    private readonly enabled: boolean;
    private readonly rules: SshRule[];
    private readonly maxTunnels: number;

    constructor(options: CloudSshTunnelOptions) {
        this.emit = options.emit;
        this.log = options.log;
        this.enabled = options.enabled;
        this.rules = Array.isArray(options.rules) ? options.rules : [];
        this.maxTunnels = options.maxTunnels || DEFAULT_MAX_TUNNELS;
    }

    /** Open a TCP socket to host:port for tunnel `id`, once the guards pass. */
    open(id: string, host: string, port: number): void {
        if (!id || this.sockets.has(id)) {
            return;
        }
        if (!this.enabled) {
            this.deny(id, 'Remote shell is disabled in the cloud adapter');
            return;
        }
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
            this.deny(id, `Invalid port ${port}`);
            return;
        }
        if (!this.isAllowed(host, port)) {
            this.deny(id, `Destination ${host}:${port} is not allowed`);
            return;
        }
        if (this.sockets.size >= this.maxTunnels) {
            this.deny(id, 'Too many open tunnels');
            return;
        }

        this.log.debug(`SSH tunnel ${id} -> ${host}:${port}`);
        const socket = connect({ host, port });
        this.sockets.set(id, socket);

        socket.on('connect', () => this.emit('sshReady', id));
        socket.on('data', (chunk: Buffer) => this.emit('sshData', id, chunk.toString('base64')));
        socket.on('error', (e: Error) => {
            this.log.warn(`SSH tunnel ${id} to ${host}:${port} failed: ${e.message}`);
            this.emit('sshError', id, e.message);
        });
        socket.on('close', () => {
            // Only report the close if we did not close it ourselves (close() deletes the entry first).
            if (this.sockets.has(id)) {
                this.sockets.delete(id);
                this.emit('sshClose', id);
            }
        });
    }

    /** Write bytes the client sent into the TCP socket. */
    write(id: string, payload: string): void {
        const socket = this.sockets.get(id);
        if (socket) {
            socket.write(Buffer.from(payload || '', 'base64'));
        }
    }

    /** Close the TCP socket because the cloud asked to - no `sshClose` is sent back for this. */
    close(id: string): void {
        const socket = this.sockets.get(id);
        if (socket) {
            this.sockets.delete(id);
            socket.destroy();
        }
    }

    /** How many tunnels are open right now. */
    get count(): number {
        return this.sockets.size;
    }

    /** Close every tunnel, e.g. on unload or when the cloud connection dropped. */
    destroy(): void {
        for (const socket of this.sockets.values()) {
            socket.destroy();
        }
        this.sockets.clear();
    }

    /** Refuse a tunnel: tell the client why and never open a socket. */
    private deny(id: string, message: string): void {
        this.log.warn(`SSH tunnel ${id} refused: ${message}`);
        this.emit('sshError', id, message);
    }

    /** A destination is allowed if any rule matches its host and, on that rule, its port. */
    private isAllowed(host: string, port: number): boolean {
        return this.rules.some(
            rule => CloudSshTunnel.hostMatches(rule.host, host) && CloudSshTunnel.portMatches(rule.ports, port),
        );
    }

    /** Match a requested host against one rule's host: exact, `*` wildcard, CIDR, or range. */
    static hostMatches(pattern: string, host: string): boolean {
        pattern = (pattern || '').trim();
        host = (host || '').trim();
        if (!pattern) {
            return false;
        }
        if (pattern === host) {
            return true;
        }
        if (pattern.includes('/')) {
            return CloudSshTunnel.cidrMatch(pattern, host);
        }
        if (pattern.includes('-')) {
            // A range like 192.168.1.10-192.168.1.50, but only when both ends and the host are real IPs;
            // otherwise a hostname that merely contains a dash falls through to the checks below.
            const [from, to] = pattern.split('-', 2).map(s => s.trim());
            const lo = CloudSshTunnel.ipToLong(from);
            const hi = CloudSshTunnel.ipToLong(to);
            const h = CloudSshTunnel.ipToLong(host);
            if (lo !== null && hi !== null && h !== null) {
                return h >= Math.min(lo, hi) && h <= Math.max(lo, hi);
            }
        }
        if (pattern.includes('*')) {
            const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
            return regex.test(host);
        }
        return false;
    }

    /** Match a port against one rule's port spec: empty/`*`/`all` = any, else a list of ports and ranges. */
    static portMatches(spec: string, port: number): boolean {
        spec = (spec || '').trim();
        if (!spec || spec === '*' || spec.toLowerCase() === 'all') {
            return true;
        }
        return spec
            .split(/[\s,;]+/)
            .filter(t => t)
            .some(token => {
                if (token.includes('-')) {
                    const [a, b] = token.split('-', 2);
                    const lo = parseInt(a, 10);
                    const hi = parseInt(b, 10);
                    return (
                        Number.isFinite(lo) &&
                        Number.isFinite(hi) &&
                        port >= Math.min(lo, hi) &&
                        port <= Math.max(lo, hi)
                    );
                }
                return parseInt(token, 10) === port;
            });
    }

    /** Match a host against a CIDR like `192.168.1.0/24`. */
    static cidrMatch(cidr: string, host: string): boolean {
        const [base, bitsStr] = cidr.split('/', 2);
        const bits = parseInt(bitsStr, 10);
        const b = CloudSshTunnel.ipToLong(base);
        const h = CloudSshTunnel.ipToLong(host);
        if (b === null || h === null || !Number.isFinite(bits) || bits < 0 || bits > 32) {
            return false;
        }
        const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1) >>> 0) >>> 0;
        return (b & mask) >>> 0 === (h & mask) >>> 0;
    }

    /** A dotted IPv4 as an unsigned 32-bit number, or null when it is not a valid IPv4. */
    static ipToLong(ip: string): number | null {
        const parts = (ip || '').trim().split('.');
        if (parts.length !== 4) {
            return null;
        }
        let long = 0;
        for (const part of parts) {
            if (!/^\d{1,3}$/.test(part)) {
                return null;
            }
            const n = parseInt(part, 10);
            if (n > 255) {
                return null;
            }
            long = (long << 8) | n;
        }
        return long >>> 0;
    }
}
