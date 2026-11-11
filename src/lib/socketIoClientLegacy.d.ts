/**
 * socket.io-client 1.7, installed under an npm alias next to socket.io-client 4.
 *
 * Its types (`@types/socket.io-client` 1.x) declare the module `socket.io-client` globally and would clash with the
 * types socket.io-client 4 brings along, so only the little the adapter uses is declared here.
 */
declare module 'socket.io-client-legacy' {
    interface LegacySocket {
        readonly connected: boolean;
        on(event: string, listener: (...args: any[]) => void): LegacySocket;
        off(event?: string, listener?: (...args: any[]) => void): LegacySocket;
        emit(event: string, ...args: any[]): LegacySocket;
        disconnect(): LegacySocket;
        close(): LegacySocket;
    }

    function lookup(url: string, options?: Record<string, unknown>): LegacySocket;

    export = lookup;
}
