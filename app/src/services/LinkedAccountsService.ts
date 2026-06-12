export type Platform = 'lichess' | 'chess.com';

export interface LinkedAccount {
    platform: Platform;
    username: string;
}

let _linkedAccounts: LinkedAccount[] = [];

export function getAccountKey(platform: Platform, username: string): string {
    return `${platform}:${username.toLowerCase()}`;
}

export function getLinkedAccounts(): LinkedAccount[] {
    return _linkedAccounts;
}

export function setLinkedAccounts(accounts: LinkedAccount[]): void {
    _linkedAccounts = accounts.map(a => ({
        ...a,
        platform: a.platform || 'lichess',
        username: a.username.toLowerCase(),
    }));
}
