import axios from 'axios';

/** How long a request for the app-key may take: without it a lost network ends it only after minutes (ETIMEDOUT) */
export const APP_KEY_TIMEOUT = 15000;
/** The first retry for the app-key comes after this, every next one after twice as long, up to APP_KEY_RETRY_MAX */
export const APP_KEY_RETRY_MIN = 10000;
export const APP_KEY_RETRY_MAX = 300000;

/**
 * If a request for the app-key may succeed later: the server did not answer at all (no network, DNS, timeout,
 * refused, reset) or the proxy in front of it says the server behind is down (5xx). A wrong login (401) or another
 * answer of the server will not change by waiting.
 *
 * @param error what axios rejected with
 */
export function isTemporaryError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
        return false;
    }
    return !error.response || error.response.status >= 500;
}

/**
 * How long to wait before the next request for the app-key: 10 seconds, then twice as long each time, at most 5 minutes
 *
 * @param attempts the failed requests in a row so far
 */
export function appKeyRetryDelay(attempts: number): number {
    return Math.min(APP_KEY_RETRY_MIN * 2 ** Math.min(attempts, 30), APP_KEY_RETRY_MAX);
}

/**
 * Why a request failed, short, for the log
 *
 * @param error what axios rejected with
 */
export function failureReason(error: unknown): string {
    if (axios.isAxiosError(error)) {
        return error.response ? `HTTP ${error.response.status}` : error.code || error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
