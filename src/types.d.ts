export interface CloudAdapterConfig {
    allowAdmin: string | false;
    allowSelfSignedCertificate: boolean;
    allowedServices: string | string[];
    apikey: string;
    cloudUrl: string;
    concatWord: string;
    connectionTimeout: number;
    deviceOffLevel: number;
    functionFirst: boolean;
    iftttKey: string;
    instance: string;
    language: Adapter.Language;
    login: string;
    lovelace: string | false;
    noCommon: boolean;
    pass: string;
    credentialType?: 'manager' | 'manual';
    credentialId?: string;
    pingTimeout: number;
    replaces: string[] | string | null;
    responseOID: string;
    restartOnDisconnect: boolean;
    server: 'iobroker.pro' | 'iobroker.net';
    text2command: `${number}`;
    useCredentials: boolean;
    onlyViewer: boolean;
    /** Remote shell (SSH jump host): let the cloud tunnel TCP connections to this machine. Off by default. */
    sshEnabled: boolean;
    /**
     * Allow-list for the SSH tunnel: one entry per host (IP, hostname, `*` wildcard, CIDR, or range) with
     * the ports allowed on it (list/ranges, or empty/`*`/`all` for any). Empty list = nothing allowed.
     */
    sshRules: { host: string; ports: string }[];
}
