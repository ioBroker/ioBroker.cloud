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
    pingTimeout: number;
    replaces: string[] | string | null;
    responseOID: string;
    restartOnDisconnect: boolean;
    server: 'iobroker.pro' | 'iobroker.net';
    text2command: `${number}`;
    useCredentials: boolean;
    onlyViewer: boolean;
}
